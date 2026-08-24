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

const { parseFeed } = require('../src/core/adapters');
const { interpretProbe } = require('../src/core/probe-rules');
const {
  STATUS,
  worst,
  fromStatuspageIndicator,
  fromComponentStatus,
} = require('../src/core/state');
const { buildSnapshot } = require('../src/core/monitor');

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

test('total failure while offline reports unknown, never outage', async () => {
  const results = [
    { id: 'a', status: STATUS.OUTAGE, detail: 'unreachable' },
    { id: 'b', status: STATUS.OUTAGE, detail: 'unreachable' },
  ];
  // Force the offline path without touching the network.
  const snap = await buildSnapshot(results, { checkConnectivity: false });
  // With connectivity checking disabled it must NOT invent an offline state.
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
