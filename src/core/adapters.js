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
 * that something IS wrong. We look at recent entries and treat an entry as an
 * open incident unless its text says it was resolved/completed. If the newest
 * entry is old, we report operational with low confidence.
 * ------------------------------------------------------------------ */
const OPEN_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

async function readFeed(url, { now = Date.now() } = {}) {
  const res = await request(url, { timeout: 8000, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' });
  if (!res.ok || !res.body) {
    return { ok: false, error: res.error || `HTTP ${res.status}`, latency: res.latency };
  }
  const entries = parseFeed(res.body);
  if (!entries.length) {
    return { ok: false, error: 'no entries in feed', latency: res.latency };
  }

  const recent = entries.filter((e) => e.date && now - e.date.getTime() < OPEN_WINDOW_MS);
  const open = recent.filter((e) => !looksResolved(e));

  let overall;
  if (open.length) {
    overall = open.some((e) => looksMajor(e)) ? STATUS.OUTAGE : STATUS.DEGRADED;
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
      ? `${open.length} open incident${open.length > 1 ? 's' : ''} reported in feed`
      : 'No open incidents in the last 6h',
    components: [],
    incidents: open.map((e) => ({
      name: e.title,
      status: 'open',
      impact: looksMajor(e) ? 'major' : 'minor',
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

function looksResolved(entry) {
  return RESOLVED_RE.test(`${entry.title} ${entry.summary}`);
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
      summary: decode(stripHtml(summary)),
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
  const r = await reach(probe.url, { timeout: 6000 });
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

module.exports = { READERS, readStatuspage, readInstatus, readFeed, runProbe, parseFeed };
