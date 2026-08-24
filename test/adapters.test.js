'use strict';

/**
 * Parser + decision-logic tests.
 *
 * These run entirely offline against recorded payload shapes, so they verify
 * the logic that decides what colour a tile goes -- which is the part that
 * must never be wrong -- without depending on a vendor being up.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseFeed, classifyEntry } = require('../src/core/adapters');
const { interpretProbe } = require('../src/core/probe-rules');
const {
  STATUS,
  worst,
  fromStatuspageIndicator,
  fromComponentStatus,
} = require('../src/core/state');
const { buildSnapshot, detectChanges } = require('../src/core/monitor');

/* ---------------------------- status mapping ---------------------------- */

test('statuspage indicators map to our vocabulary', () => {
  assert.equal(fromStatuspageIndicator('none'), STATUS.OPERATIONAL);
  assert.equal(fromStatuspageIndicator('minor'), STATUS.DEGRADED);
  assert.equal(fromStatuspageIndicator('major'), STATUS.OUTAGE);
  assert.equal(fromStatuspageIndicator('critical'), STATUS.OUTAGE);
  assert.equal(fromStatuspageIndicator('maintenance'), STATUS.MAINTENANCE);
  assert.equal(fromStatuspageIndicator('something-new'), STATUS.UNKNOWN);
});

test('component statuses map across Statuspage and Instatus spellings', () => {
  assert.equal(fromComponentStatus('operational'), STATUS.OPERATIONAL);
  assert.equal(fromComponentStatus('UP'), STATUS.OPERATIONAL);
  assert.equal(fromComponentStatus('degraded_performance'), STATUS.DEGRADED);
  assert.equal(fromComponentStatus('HASISSUES'), STATUS.DEGRADED);
  assert.equal(fromComponentStatus('major_outage'), STATUS.OUTAGE);
  assert.equal(fromComponentStatus('under_maintenance'), STATUS.MAINTENANCE);
});

test('worst() escalates and treats an empty list as unknown', () => {
  assert.equal(worst([STATUS.OPERATIONAL, STATUS.DEGRADED]), STATUS.DEGRADED);
  assert.equal(worst([STATUS.DEGRADED, STATUS.OUTAGE]), STATUS.OUTAGE);
  assert.equal(worst([STATUS.OPERATIONAL, STATUS.UNKNOWN]), STATUS.UNKNOWN);
  assert.equal(worst([]), STATUS.UNKNOWN);
});

/* ------------------------------ probe rules ----------------------------- */

test('403 is never treated as healthy', () => {
  // A blocking proxy, VPN or WAF returns 403 exactly like a real API can.
  const r = interpretProbe(403, { healthyHttp: [400, 401, 405] });
  assert.equal(r.status, STATUS.UNKNOWN);
  assert.match(r.note, /blocked/i);
});

test('401 and 405 from an API host count as alive', () => {
  assert.equal(interpretProbe(401, { healthyHttp: [400, 401, 405] }).status, STATUS.OPERATIONAL);
  assert.equal(interpretProbe(405, { healthyHttp: [400, 401, 405] }).status, STATUS.OPERATIONAL);
  assert.equal(interpretProbe(200, {}).status, STATUS.OPERATIONAL);
});

test('server errors and rate limits are graded correctly', () => {
  assert.equal(interpretProbe(500, {}).status, STATUS.OUTAGE);
  assert.equal(interpretProbe(503, {}).status, STATUS.OUTAGE);
  assert.equal(interpretProbe(429, {}).status, STATUS.DEGRADED);
  assert.equal(interpretProbe(0, { error: 'timeout' }).status, STATUS.OUTAGE);
});

/* ------------------------------ feed parsing ---------------------------- */

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>xAI Status</title>
  <item>
    <title>API latency elevated in us-east-1</title>
    <description><![CDATA[<p>We are <b>investigating</b> elevated latency.</p>]]></description>
    <pubDate>__RECENT__</pubDate>
    <link>https://status.x.ai/incident/1</link>
  </item>
  <item>
    <title>Console login errors</title>
    <description>This incident has been resolved.</description>
    <pubDate>__RECENT__</pubDate>
    <link>https://status.x.ai/incident/2</link>
  </item>
  <item>
    <title>Ancient major outage</title>
    <description>Everything was down.</description>
    <pubDate>__OLD__</pubDate>
  </item>
</channel></rss>`;

function fixture() {
  const recent = new Date(Date.now() - 30 * 60 * 1000).toUTCString();
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toUTCString();
  return RSS_FIXTURE.replace(/__RECENT__/g, recent).replace(/__OLD__/g, old);
}

test('parseFeed extracts title, date, link and strips CDATA/HTML', () => {
  const entries = parseFeed(fixture());
  assert.equal(entries.length, 3);
  assert.equal(entries[0].title, 'API latency elevated in us-east-1');
  assert.equal(entries[0].link, 'https://status.x.ai/incident/1');
  assert.ok(entries[0].date instanceof Date);
  // CDATA unwrapped and tags stripped.
  assert.match(entries[0].summary, /investigating elevated latency/i);
  assert.ok(!entries[0].summary.includes('<b>'));
});

test('parseFeed handles Atom <entry> with href links', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>Partial outage</title>
      <summary>Some requests failing.</summary>
      <updated>2026-08-24T10:00:00Z</updated>
      <link rel="alternate" href="https://status.example.com/x"/>
    </entry>
  </feed>`;
  const e = parseFeed(atom);
  assert.equal(e.length, 1);
  assert.equal(e[0].title, 'Partial outage');
  assert.equal(e[0].link, 'https://status.example.com/x');
});

test('parseFeed returns nothing for an HTML error page', () => {
  assert.deepEqual(parseFeed('<html><body>Not found</body></html>'), []);
});

/* --------------------------- offline behaviour -------------------------- */

test('disabling the connectivity check never invents an offline state', async () => {
  const results = [
    { id: 'a', status: STATUS.OUTAGE, detail: 'unreachable' },
    { id: 'b', status: STATUS.OUTAGE, detail: 'unreachable' },
  ];
  const snap = await buildSnapshot(results, { checkConnectivity: false });
  assert.equal(snap.offline, false);
  assert.equal(snap.overall, STATUS.OUTAGE);
});

test('all providers failing while offline downgrades everything to unknown', async () => {
  const results = [
    { id: 'a', status: STATUS.OUTAGE, detail: 'unreachable' },
    { id: 'b', status: STATUS.OUTAGE, detail: 'unreachable' },
  ];
  const snap = await buildSnapshot(results, { checkConnectivity: async () => false });
  assert.equal(snap.offline, true);
  assert.equal(snap.overall, STATUS.UNKNOWN);
  for (const r of snap.providers) {
    assert.equal(r.status, STATUS.UNKNOWN);
    assert.match(r.detail, /no internet/i);
  }
});

test('all providers failing while online stays a real outage', async () => {
  const results = [
    { id: 'a', status: STATUS.OUTAGE },
    { id: 'b', status: STATUS.OUTAGE },
  ];
  const snap = await buildSnapshot(results, { checkConnectivity: async () => true });
  assert.equal(snap.offline, false);
  assert.equal(snap.overall, STATUS.OUTAGE);
});

test('a healthy provider prevents the offline downgrade', async () => {
  const results = [
    { id: 'a', status: STATUS.OPERATIONAL },
    { id: 'b', status: STATUS.OUTAGE },
  ];
  const snap = await buildSnapshot(results);
  // One provider is fine, so we are plainly online: no connectivity check, and
  // the real outage is preserved.
  assert.equal(snap.offline, false);
  assert.equal(snap.overall, STATUS.OUTAGE);
});

/* --------------------------- entry classification ------------------------ */

test('newest-update state keyword is authoritative over old recovery text', () => {
  // Statuspage concatenates updates newest-first; recovery words about an
  // EARLIER incident deep in the history must not close this one.
  assert.equal(
    classifyEntry({
      title: 'API errors',
      summary:
        'Investigating - Error rates are spiking. Update - A separate issue ' +
        'earlier today has been resolved and the fix has been completed.',
    }),
    'open'
  );
  assert.equal(
    classifyEntry({ title: 'API errors', summary: 'Resolved - This incident has been resolved.' }),
    'resolved'
  );
  assert.equal(
    classifyEntry({ title: 'API errors', summary: 'Monitoring - A fix is being monitored.' }),
    'open'
  );
});

test('maintenance announcements are not incidents', () => {
  assert.equal(
    classifyEntry({
      title: 'Scheduled maintenance for the database tier',
      summary: 'Scheduled - We will be performing scheduled maintenance this weekend.',
    }),
    'scheduled'
  );
  assert.equal(
    classifyEntry({
      title: 'Scheduled maintenance for the database tier',
      summary: 'In progress - Scheduled maintenance is currently in progress.',
    }),
    'maintenance'
  );
  assert.equal(
    classifyEntry({
      title: 'Scheduled maintenance for the database tier',
      summary: 'Completed - The scheduled maintenance has been completed.',
    }),
    'resolved'
  );
});

test('plain incidents without state prefixes fall back to head-only matching', () => {
  assert.equal(
    classifyEntry({ title: 'Elevated latency', summary: 'We are investigating elevated latency.' }),
    'open'
  );
  assert.equal(
    classifyEntry({ title: 'Elevated latency', summary: 'The issue has been fixed.' }),
    'resolved'
  );
});

/* ---------------------------- change detection --------------------------- */

function snap(providers, offline = false) {
  return { at: new Date().toISOString(), offline, providers };
}

test('a transition through unknown still reports the real change', () => {
  const lastKnown = new Map();
  const pending = new Map();

  // Cycle 1: healthy, page-confirmed.
  let c = detectChanges(
    snap([{ id: 'a', status: STATUS.OPERATIONAL, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );
  assert.equal(c.length, 0);

  // Cycle 2: status page times out under incident load -> unknown. No event,
  // but also no forgetting.
  c = detectChanges(snap([{ id: 'a', status: STATUS.UNKNOWN, source: null }]), lastKnown, pending);
  assert.equal(c.length, 0);

  // Cycle 3: page is back and reports the outage. The user must hear about it.
  c = detectChanges(
    snap([{ id: 'a', status: STATUS.OUTAGE, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );
  assert.equal(c.length, 1);
  assert.equal(c[0].from, STATUS.OPERATIONAL);
  assert.equal(c[0].to, STATUS.OUTAGE);
});

test('probe-only outage needs two consecutive cycles before it alerts', () => {
  const lastKnown = new Map();
  const pending = new Map();

  detectChanges(
    snap([{ id: 'a', status: STATUS.OPERATIONAL, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );

  // First probe-driven outage cycle: suppressed.
  let c = detectChanges(
    snap([{ id: 'a', status: STATUS.OUTAGE, source: null }]),
    lastKnown, pending
  );
  assert.equal(c.length, 0);

  // Second consecutive cycle: now it is real.
  c = detectChanges(snap([{ id: 'a', status: STATUS.OUTAGE, source: null }]), lastKnown, pending);
  assert.equal(c.length, 1);
  assert.equal(c[0].to, STATUS.OUTAGE);
});

test('a single probe-outage blip between healthy cycles never alerts', () => {
  const lastKnown = new Map();
  const pending = new Map();

  detectChanges(
    snap([{ id: 'a', status: STATUS.OPERATIONAL, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );
  let c = detectChanges(
    snap([{ id: 'a', status: STATUS.OUTAGE, source: null }]),
    lastKnown, pending
  );
  assert.equal(c.length, 0);
  c = detectChanges(
    snap([{ id: 'a', status: STATUS.OPERATIONAL, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );
  assert.equal(c.length, 0); // and the recovery is silent too: nothing was announced
});

test('page-confirmed outage alerts immediately, then recovery alerts once', () => {
  const lastKnown = new Map();
  const pending = new Map();

  detectChanges(
    snap([{ id: 'a', status: STATUS.OPERATIONAL, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );
  let c = detectChanges(
    snap([{ id: 'a', status: STATUS.OUTAGE, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );
  assert.equal(c.length, 1);

  c = detectChanges(
    snap([{ id: 'a', status: STATUS.OPERATIONAL, source: { kind: 'statuspage' } }]),
    lastKnown, pending
  );
  assert.equal(c.length, 1);
  assert.equal(c[0].to, STATUS.OPERATIONAL);
});

test('offline snapshots emit no change events', () => {
  const lastKnown = new Map([['a', STATUS.OPERATIONAL]]);
  const pending = new Map();
  const c = detectChanges(
    snap([{ id: 'a', status: STATUS.UNKNOWN, source: null }], true),
    lastKnown, pending
  );
  assert.equal(c.length, 0);
});

/* ------------------------------ catalog sanity --------------------------- */

const { CATALOG } = require('../src/core/providers');
const { READERS } = require('../src/core/adapters');
const { Monitor } = require('../src/core/monitor');

test('catalog entries are well-formed and every source kind has a reader', () => {
  const ids = new Set();
  for (const p of CATALOG) {
    assert.ok(p.id && !ids.has(p.id), `duplicate or missing id: ${p.id}`);
    ids.add(p.id);
    assert.ok(p.name && p.vendor, `${p.id}: name/vendor required`);
    assert.doesNotThrow(() => new URL(p.homepage), `${p.id}: bad homepage`);
    assert.ok(p.sources.length >= 1, `${p.id}: needs at least one source`);
    for (const src of p.sources) {
      assert.ok(READERS[src.kind], `${p.id}: no reader for kind "${src.kind}"`);
      assert.doesNotThrow(() => new URL(src.url), `${p.id}: bad source url ${src.url}`);
    }
    if (p.probe) {
      assert.doesNotThrow(() => new URL(p.probe.url), `${p.id}: bad probe url`);
      assert.ok(
        !(p.probe.healthyHttp || []).includes(403),
        `${p.id}: 403 must never be listed as healthy`
      );
    }
  }
  // The original five are still present.
  for (const id of ['claude', 'openai', 'deepseek', 'kimi', 'grok']) {
    assert.ok(ids.has(id), `missing original provider ${id}`);
  }
});

test('setProviders prunes per-provider alerting state for removed providers', () => {
  const m = new Monitor({ providers: [] });
  m.lastKnown.set('a', STATUS.OPERATIONAL);
  m.lastKnown.set('b', STATUS.OUTAGE);
  m.pendingProbeOutage.set('b', 1);
  m.setProviders([{ id: 'a' }]);
  assert.ok(m.lastKnown.has('a'));
  assert.ok(!m.lastKnown.has('b'));
  assert.ok(!m.pendingProbeOutage.has('b'));
});

/* ----------------------------- stale fallback ---------------------------- */

test('a one-cycle source failure reuses the recent good reading, marked stale', () => {
  const m = new Monitor({ providers: [] });
  const good = {
    id: 'a', status: STATUS.OPERATIONAL, detail: 'All good',
    source: { kind: 'feed' }, components: [], incidents: [],
  };
  let out = m.applyStaleFallback([good]);
  assert.equal(out[0].stale, undefined);

  const failed = {
    id: 'a', status: STATUS.UNKNOWN, detail: 'No status source reachable',
    source: null, probe: null, attempts: [],
  };
  out = m.applyStaleFallback([failed]);
  assert.equal(out[0].status, STATUS.OPERATIONAL);
  assert.equal(out[0].stale, true);
  assert.match(out[0].detail, /cached/);

  // A stale substitution must never refresh the cache: simulate the TTL
  // passing and the next failure goes back to an honest Unknown.
  m.lastGood.get('a').at = Date.now() - 16 * 60_000;
  out = m.applyStaleFallback([failed]);
  assert.equal(out[0].status, STATUS.UNKNOWN);
});

test('a probe-driven outage is never masked by the stale cache', () => {
  const m = new Monitor({ providers: [] });
  m.applyStaleFallback([
    { id: 'a', status: STATUS.OPERATIONAL, detail: 'ok', source: { kind: 'feed' } },
  ]);
  const outage = {
    id: 'a', status: STATUS.OUTAGE, detail: 'API host unreachable', source: null,
  };
  const out = m.applyStaleFallback([outage]);
  assert.equal(out[0].status, STATUS.OUTAGE);
  assert.ok(!out[0].stale);
});
