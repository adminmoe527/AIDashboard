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
      record.detail = 'No readable status page; live API answering normally';
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

  // The probe can only ever escalate on a DEFINITIVE bad signal (5xx,
  // unreachable, rate-limited) -- a green status page with a dead API host is
  // precisely the case this app exists to catch, and pages lag incidents by
  // 5-15 minutes. But an AMBIGUOUS probe (403 behind a corporate proxy/VPN,
  // an unrecognised code) must never override a readable status page: that
  // would grey out perfectly good tiles for anyone behind a middlebox.
  if (
    probeResult &&
    probeResult.status !== STATUS.UNKNOWN &&
    rank(probeResult.status) > rank(status)
  ) {
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
 *
 * `checkConnectivity` may be `true` (use the real isOnline()), `false` (never
 * downgrade), or an async function returning a boolean (for tests).
 */
async function buildSnapshot(results, { checkConnectivity = true } = {}) {
  const allBad = results.length > 0 && results.every((r) => r.status !== STATUS.OPERATIONAL);
  let offline = false;

  if (allBad && checkConnectivity) {
    const online =
      typeof checkConnectivity === 'function' ? await checkConnectivity() : await isOnline();
    offline = !online;
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
 * Change detection over DEFINITIVE statuses.
 *
 * Pure so it can be tested without the network. Mutates the two maps it is
 * given (they are the caller's persistent state) and returns the change
 * events to emit. Three rules, each closing a real alerting hole:
 *
 * 1. UNKNOWN is never a transition endpoint. It means "we couldn't tell",
 *    not "something happened" -- but it must not swallow real news either,
 *    so transitions are computed against the last *definitive* status. A
 *    status page that times out for one cycle mid-outage still produces
 *    operational -> outage, not silence.
 * 2. An OUTAGE grounded only in the probe (page unreachable, or page-green
 *    escalated by the probe) needs two consecutive cycles before it emits --
 *    a single failed connection is not proof. The snapshot/tile still shows
 *    it immediately; only the alert is debounced.
 * 3. Offline snapshots produce no events at all.
 */
function detectChanges(snapshot, lastKnown, pendingProbeOutage) {
  const changes = [];
  if (snapshot.offline) return changes;

  for (const r of snapshot.providers) {
    if (r.status === STATUS.UNKNOWN) continue;

    const probeDriven = r.probeEscalated || !r.source;
    if (r.status === STATUS.OUTAGE && probeDriven) {
      const seen = (pendingProbeOutage.get(r.id) || 0) + 1;
      pendingProbeOutage.set(r.id, seen);
      if (seen < 2) continue;
    } else {
      pendingProbeOutage.delete(r.id);
    }

    const known = lastKnown.get(r.id);
    if (known && known !== r.status) {
      changes.push({ provider: r, from: known, to: r.status });
    }
    lastKnown.set(r.id, r.status);
  }
  return changes;
}

/**
 * Long-running poller. Emits:
 *   'update'  (snapshot)                  every completed cycle
 *   'change'  ({ provider, from, to })    definitive status transitions
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
    this.lastKnown = new Map();
    this.pendingProbeOutage = new Map();
    this.wasAllBad = false;
    // id -> { record, at } of the last reading that came from a real source.
    this.lastGood = new Map();
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

  /**
   * Swap the monitored provider set at runtime (the picker calls this).
   * State for providers no longer monitored is dropped so a re-enable later
   * starts fresh instead of comparing against stale history.
   */
  setProviders(providers) {
    this.providers = providers;
    const ids = new Set(providers.map((p) => p.id));
    for (const map of [this.lastKnown, this.pendingProbeOutage, this.lastGood]) {
      for (const key of [...map.keys()]) {
        if (!ids.has(key)) map.delete(key);
      }
    }
    this.wasAllBad = false;
    return this;
  }

  /**
   * Some status-page CDNs drop connections intermittently under repeated
   * polling (DeepSeek's does). When every source fails for one cycle but a
   * real reading succeeded within the last 15 minutes, reuse it -- marked
   * stale -- instead of flapping the tile to Unknown. A probe-driven OUTAGE
   * is never masked this way, and stale readings are never re-cached, so a
   * page that stays dead ages out to an honest Unknown.
   */
  applyStaleFallback(results) {
    const STALE_TTL_MS = 15 * 60_000;
    const now = Date.now();
    return results.map((r) => {
      if (r.source && !r.stale) {
        this.lastGood.set(r.id, { record: r, at: now });
        return r;
      }
      const cached = this.lastGood.get(r.id);
      if (r.status === STATUS.UNKNOWN && cached && now - cached.at < STALE_TTL_MS) {
        const mins = Math.max(1, Math.round((now - cached.at) / 60_000));
        return {
          ...cached.record,
          checkedAt: r.checkedAt,
          probe: r.probe,
          attempts: r.attempts,
          stale: true,
          detail: `${cached.record.detail} (cached ${mins}m ago; sources unreachable this cycle)`,
        };
      }
      return r;
    });
  }

  isAllBad(snapshot) {
    return (
      !snapshot.offline &&
      snapshot.providers.length > 0 &&
      snapshot.providers.every((p) => p.status !== STATUS.OPERATIONAL)
    );
  }

  async refresh() {
    if (this.running) return this.snapshot;
    this.running = true;
    try {
      let results = this.applyStaleFallback(
        await checkAll(this.providers, { probe: this.probe })
      );
      let snapshot = await buildSnapshot(results);

      // Everything failing at once right after a healthy cycle is far more
      // often a local blip that healed mid-cycle (wifi roam, VPN reconnect,
      // laptop wake) than five vendors dying simultaneously -- and because
      // the connectivity check runs after the provider checks, a blip that
      // heals in between would otherwise paint five false reds. Re-check
      // once and trust only the second answer. A genuine multi-vendor
      // outage survives the recheck and costs one cycle of extra latency.
      if (this.isAllBad(snapshot) && !this.wasAllBad) {
        results = this.applyStaleFallback(
          await checkAll(this.providers, { probe: this.probe })
        );
        snapshot = await buildSnapshot(results);
      }
      this.wasAllBad = this.isAllBad(snapshot);

      const changes = detectChanges(snapshot, this.lastKnown, this.pendingProbeOutage);

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
  detectChanges,
  DEFAULT_INTERVAL_MS,
  STATUS,
};
