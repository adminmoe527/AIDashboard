'use strict';

const { requestJson, request, reach } = require('./fetcher');
const { interpretProbe } = require('./probe-rules');
const {
  STATUS,
  worst,
  fromStatuspageIndicator,
  fromComponentStatus,
} = require('./state');

/* ------------------------------------------------------------------ *
 * Atlassian Statuspage v2  ->  /api/v2/summary.json
 * ------------------------------------------------------------------ */
async function readStatuspage(url) {
  const res = await requestJson(url, { timeout: 8000 });
  if (!res.ok || !res.json) {
    return { ok: false, error: res.error || `HTTP ${res.status}`, latency: res.latency };
  }
  const j = res.json;
  if (!j.status && !Array.isArray(j.components)) {
    return { ok: false, error: 'unrecognised Statuspage payload', latency: res.latency };
  }

  const components = (j.components || [])
    // Statuspage returns sub-components too; group children add noise.
    .filter((c) => !c.group)
    .map((c) => ({
      name: c.name,
      status: fromComponentStatus(c.status),
    }));

  const incidents = (j.incidents || []).map(normaliseIncident);
  const maintenances = (j.scheduled_maintenances || [])
    .filter((m) => m.status === 'in_progress')
    .map(normaliseIncident);

  let overall = fromStatuspageIndicator(j.status && j.status.indicator);
  if (overall === STATUS.UNKNOWN && components.length) {
    overall = worst(components.map((c) => c.status));
  }

  return {
    ok: true,
    kind: 'statuspage',
    overall,
    description: (j.status && j.status.description) || null,
    components,
    incidents: incidents.concat(maintenances),
    latency: res.latency,
    sourceUrl: url,
  };
}

/* ------------------------------------------------------------------ *
 * Instatus  ->  /summary.json
 * Shape: { page: {...}, activeIncidents: [], activeMaintenances: [] }
 * ------------------------------------------------------------------ */
async function readInstatus(url) {
  const res = await requestJson(url, { timeout: 8000 });
  if (!res.ok || !res.json) {
    return { ok: false, error: res.error || `HTTP ${res.status}`, latency: res.latency };
  }
  const j = res.json;
  // Guard against a Statuspage payload arriving here (or vice versa).
  if (!j.page && !j.activeIncidents && !Array.isArray(j.components)) {
    return { ok: false, error: 'unrecognised Instatus payload', latency: res.latency };
  }

  const components = (j.components || []).map((c) => ({
    name: c.name,
    status: fromComponentStatus(c.status),
  }));

  const active = []
    .concat(j.activeIncidents || [])
    .concat(j.activeMaintenances || []);

  const incidents = active.map((i) => ({
    name: i.name,
    status: i.status || 'active',
    impact: i.impact || null,
    updatedAt: i.updated_at || i.updatedAt || null,
    url: i.url || null,
    body: null,
  }));

  let overall;
  const pageStatus = j.page && (j.page.status || j.page.status_description);
  if (pageStatus) overall = fromComponentStatus(pageStatus);
  if (!overall || overall === STATUS.UNKNOWN) {
    if (components.length) overall = worst(components.map((c) => c.status));
    else if (active.length) overall = STATUS.DEGRADED;
    else overall = STATUS.UNKNOWN;
  }

  return {
    ok: true,
    kind: 'instatus',
    overall,
    description: pageStatus || null,
    components,
    incidents,
    latency: res.latency,
    sourceUrl: url,
  };
}

/* ------------------------------------------------------------------ *
 * RSS / Atom incident feed
 *
 * A feed carries no "everything is fine" record, so it can only ever prove
 * that something IS wrong. Real-world feeds come in two shapes:
 *   - one item per incident with every update concatenated in the
 *     description, newest first (Atlassian Statuspage history.rss);
 *   - one item per update, where updates of the same incident share a link
 *     (OpenAI's feed.rss, Instatus feeds).
 * So we group entries by incident link, keep only the newest entry of each
 * group, and classify that entry alone -- recovery words buried in older
 * update history must never hide a still-open incident, and an incident is
 * open until its newest update says otherwise, however old it is (within the
 * lookback window).
 * ------------------------------------------------------------------ */
const LOOKBACK_MS = 48 * 60 * 60 * 1000; // how far back an incident can still matter
const FUTURE_SLOP_MS = 5 * 60 * 1000; // tolerate small clock skew on feed dates

async function readFeed(url, { now = Date.now() } = {}) {
  const res = await request(url, { timeout: 8000, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' });
  if (!res.ok || !res.body) {
    return { ok: false, error: res.error || `HTTP ${res.status}`, latency: res.latency };
  }
  const entries = parseFeed(res.body);
  if (!entries.length) {
    return { ok: false, error: 'no entries in feed', latency: res.latency };
  }

  // Newest entry per incident, bounded to the lookback window.
  const newest = new Map();
  for (const e of entries) {
    if (!e.date) continue;
    const t = e.date.getTime();
    if (t > now + FUTURE_SLOP_MS || now - t > LOOKBACK_MS) continue;
    const key = e.link || e.title;
    const prev = newest.get(key);
    if (!prev || e.date > prev.date) newest.set(key, e);
  }

  const open = [];
  for (const e of newest.values()) {
    const cls = classifyEntry(e);
    if (cls === 'resolved' || cls === 'scheduled') continue;
    open.push({ entry: e, cls });
  }

  const active = open.filter((o) => o.cls !== 'maintenance');
  let overall;
  if (active.length) {
    overall = active.some((o) => looksMajor(o.entry)) ? STATUS.OUTAGE : STATUS.DEGRADED;
  } else if (open.length) {
    overall = STATUS.MAINTENANCE;
  } else {
    overall = STATUS.OPERATIONAL;
  }

  return {
    ok: true,
    kind: 'feed',
    overall,
    // A feed is a weaker signal than a component list; say so.
    confidence: open.length ? 'reported' : 'inferred',
    description: open.length
      ? `${open.length} open item${open.length > 1 ? 's' : ''} in the incident feed`
      : 'No open incidents in the feed (last 48h)',
    components: [],
    incidents: open.map(({ entry: e, cls }) => ({
      name: e.title,
      status: cls === 'maintenance' ? 'maintenance' : 'open',
      impact: cls === 'maintenance' ? 'maintenance' : looksMajor(e) ? 'major' : 'minor',
      updatedAt: e.date ? e.date.toISOString() : null,
      url: e.link,
      body: e.summary,
    })),
    latency: res.latency,
    sourceUrl: url,
  };
}

const RESOLVED_RE = /\b(resolved|completed|recovered|mitigated|back to normal|operating normally|has been fixed)\b/i;
const MAJOR_RE = /\b(major|critical|outage|unavailable|down|severe)\b/i;
const MAINT_RE = /\b(scheduled|planned)\s+maintenance\b/i;

/**
 * Classify the newest entry of one incident:
 *   'resolved'    the incident is over
 *   'scheduled'   a maintenance announcement whose window hasn't started
 *   'maintenance' maintenance currently in progress
 *   'open'        a live incident
 *
 * Statuspage prefixes each update with its state ("Resolved - ...",
 * "Investigating - ...") and orders updates newest-first, so a leading state
 * keyword is authoritative. The fallback scans only the title and the head of
 * the summary -- the newest update's region -- so recovery language deep in a
 * concatenated update history cannot mask an open incident.
 */
function classifyEntry(entry) {
  const title = entry.title || '';
  const summary = entry.summary || '';
  const maint = MAINT_RE.test(`${title} ${summary}`) || /\bmaintenance\b/i.test(title);

  const lead = summary.match(
    /^\s*(resolved|completed|investigating|identified|monitoring|in progress|scheduled|verifying|update)\b/i
  );
  if (lead) {
    const k = lead[1].toLowerCase();
    if (k === 'resolved' || k === 'completed') return 'resolved';
    if (k === 'scheduled') return maint ? 'scheduled' : 'open';
    if (maint) return 'maintenance';
    return 'open';
  }

  if (maint) {
    if (/\b(completed|complete)\b/i.test(summary)) return 'resolved';
    if (/\bin progress\b/i.test(summary)) return 'maintenance';
    return 'scheduled';
  }

  const head = `${title} ${summary.slice(0, 200)}`;
  return RESOLVED_RE.test(head) ? 'resolved' : 'open';
}

function looksMajor(entry) {
  return MAJOR_RE.test(`${entry.title} ${entry.summary}`);
}

/**
 * Minimal RSS/Atom reader. Deliberately dependency-free: we only need title,
 * link, date and summary, and pulling an XML library in for that is not worth
 * the supply-chain surface in a background app.
 */
function parseFeed(xml) {
  const blocks = [];
  const itemRe = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) blocks.push(m[0]);

  return blocks.slice(0, 25).map((b) => {
    const title = tag(b, 'title');
    const summary = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const raw =
      tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date');
    const d = raw ? new Date(raw) : null;
    return {
      title: decode(title),
      // Decode entities first, then strip: feeds that entity-encode their
      // HTML would otherwise keep their tags after decoding.
      summary: stripHtml(decode(summary)).trim(),
      link: attr(b, 'link', 'href') || tag(b, 'link') || null,
      date: d && !Number.isNaN(d.getTime()) ? d : null,
    };
  });
}

function tag(block, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m ? cdata(m[1]).trim() : '';
}
function attr(block, name, a) {
  const re = new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, 'i');
  const m = block.match(re);
  return m ? m[1] : null;
}
function cdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function normaliseIncident(i) {
  const latest = (i.incident_updates && i.incident_updates[0]) || null;
  return {
    name: i.name,
    status: i.status,
    impact: i.impact || null,
    updatedAt: i.updated_at || i.started_at || null,
    url: i.shortlink || null,
    body: latest ? decode(stripHtml(latest.body || '')) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Keyless reachability probe against the live API host.
 * ------------------------------------------------------------------ */
async function runProbe(probe) {
  if (!probe || !probe.url) return null;
  let r = await reach(probe.url, { timeout: 6000 });
  if (r.httpStatus === 0) {
    // One transient DNS/socket hiccup must not grade a provider as down;
    // confirm total unreachability with a second attempt.
    await new Promise((resolve) => setTimeout(resolve, 750));
    r = await reach(probe.url, { timeout: 6000 });
  }
  return interpretProbe(r.httpStatus, {
    healthyHttp: probe.healthyHttp,
    latency: r.latency,
    error: r.error,
  });
}

const READERS = {
  statuspage: readStatuspage,
  instatus: readInstatus,
  feed: readFeed,
};

module.exports = { READERS, readStatuspage, readInstatus, readFeed, runProbe, parseFeed, classifyEntry };
