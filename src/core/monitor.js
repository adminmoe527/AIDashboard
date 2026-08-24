'use strict';

const { EventEmitter } = require('events');
const { PROVIDERS } = require('./providers');
const { READERS, runProbe } = require('./adapters');
const { isOnline } = require('./fetcher');
const { STATUS, LABEL, rank, worst, History } = require('./state');

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Resolve one provider to a single status record.
 *
 * Strategy: walk the provider's sources in order until one returns a usable
 * reading, run the keyless API probe in parallel, then reconcile the two.
 */
async function checkProvider(provider, { probe = true } = {}) {
  const attempts = [];
  const probePromise = probe ? runProbe(provider.probe) : Promise.resolve(null);

  let reading = null;
  for (const source of provider.sources) {
    const reader = READERS[source.kind];
    if (!reader) continue;
    let r;
    try {
      r = await reader(source.url);
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    attempts.push({ kind: source.kind, url: source.url, ok: !!r.ok, error: r.error || null });
    if (r.ok) {
      reading = r;
      break;
    }
  }

  const probeResult = await probePromise.catch(() => null);

  const record = {
    id: provider.id,
    name: provider.name,
    vendor: provider.vendor,
    homepage: provider.homepage,
    checkedAt: new Date().toISOString(),
    attempts,
    probe: probeResult,
  };

  if (!reading) {
    // No status page reachable. Fall back to the probe alone, and be explicit
    // that this is a weaker answer than a real status page.
    if (probeResult && probeResult.status === STATUS.OUTAGE) {
      record.status = STATUS.OUTAGE;
      record.detail = `API host unreachable (${probeResult.note})`;
    } else if (probeResult && probeResult.status === STATUS.OPERATIONAL) {
      record.status = STATUS.UNKNOWN;
      record.detail = 'Status page unavailable; API host is responding';
    } else {
      record.status = STATUS.UNKNOWN;
      record.detail = 'No status source reachable';
    }
    record.source = null;
    record.components = [];
    record.incidents = [];
    return record;
  }

  record.source = { kind: reading.kind, url: reading.sourceUrl, latency: reading.latency };
  record.components = reading.components || [];
  record.incidents = reading.incidents || [];
  record.detail = reading.description || LABEL[reading.overall];

  let status = reading.overall;

  // The probe can only ever escalate, never reassure: a green status page with
  // a dead API host is precisely the case this app is meant to catch, and the
  // page is often 5-15 minutes behind reality.
  if (probeResult && rank(probeResult.status) > rank(status)) {
    status = probeResult.status;
    record.detail = `Status page says "${LABEL[reading.overall]}", but live probe: ${probeResult.note || LABEL[probeResult.status]}`;
    record.probeEscalated = true;
  }

  record.status = status;
  return record;
}

/** Check every provider concurrently. */
async function checkAll(providers = PROVIDERS, opts = {}) {
  return Promise.all(providers.map((p) => checkProvider(p, opts)));
}

/**
 * Turn a set of results into a snapshot, downgrading to an "offline" snapshot
 * when the failures are ours rather than theirs.
 *
 * Every provider failing at once is far more likely to mean "the laptop lost
 * wifi" than "all five vendors died simultaneously", so we verify our own
 * connectivity before reporting anything as an outage.
 */
async function buildSnapshot(results, { checkConnectivity = true } = {}) {
  const allBad = results.length > 0 && results.every((r) => r.status !== STATUS.OPERATIONAL);
  let offline = false;

  if (allBad && checkConnectivity) {
    offline = !(await isOnline());
  }

  if (offline) {
    for (const r of results) {
      r.status = STATUS.UNKNOWN;
      r.detail = 'No internet connection from this machine';
      r.offline = true;
    }
  }

  return {
    at: new Date().toISOString(),
    offline,
    overall: offline ? STATUS.UNKNOWN : worst(results.map((r) => r.status)),
    providers: results,
  };
}

/**
 * Long-running poller. Emits:
 *   'update'  (snapshot)                  every completed cycle
 *   'change'  ({ provider, from, to })    when a provider's status changes
 *   'error'   (err)
 */
class Monitor extends EventEmitter {
  constructor({ intervalMs = DEFAULT_INTERVAL_MS, providers = PROVIDERS, probe = true } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.providers = providers;
    this.probe = probe;
    this.timer = null;
    this.running = false;
    this.snapshot = null;
    this.history = new History(240);
    this.previous = new Map();
  }

  start() {
    if (this.timer) return this;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  setPollInterval(ms) {
    this.intervalMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.refresh(), this.intervalMs);
      if (this.timer.unref) this.timer.unref();
    }
    return this;
  }

  async refresh() {
    if (this.running) return this.snapshot;
    this.running = true;
    try {
      const results = await checkAll(this.providers, { probe: this.probe });
      const snapshot = await buildSnapshot(results);

      // Suppress change events while offline: we don't actually know anything,
      // and firing five "degraded" alerts on a wifi blip destroys trust.
      const changes = [];
      for (const r of snapshot.providers) {
        const prev = this.previous.get(r.id);
        if (!snapshot.offline && prev && prev !== r.status) {
          changes.push({ provider: r, from: prev, to: r.status });
        }
        if (!snapshot.offline) this.previous.set(r.id, r.status);
      }

      this.snapshot = snapshot;
      this.history.push({
        at: snapshot.at,
        overall: snapshot.overall,
        byId: Object.fromEntries(snapshot.providers.map((r) => [r.id, r.status])),
      });

      for (const c of changes) this.emit('change', c);
      this.emit('update', snapshot);
      return snapshot;
    } catch (err) {
      this.emit('error', err);
      return this.snapshot;
    } finally {
      this.running = false;
    }
  }
}

module.exports = {
  Monitor,
  checkProvider,
  checkAll,
  buildSnapshot,
  DEFAULT_INTERVAL_MS,
  STATUS,
};
