'use strict';

const USER_AGENT =
  'ai-status-dashboard/1.0 (+https://github.com/adminmoe527/AIDashboard)';

/**
 * fetch() with a hard timeout and a normalised result shape.
 * Never throws -- callers get `{ ok:false, error }` instead, because a single
 * unreachable provider must not take down the whole polling cycle.
 */
async function request(url, { timeout = 8000, accept = 'application/json' } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept,
        'cache-control': 'no-cache',
      },
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      body,
      url: res.url || url,
      latency: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: '',
      url,
      latency: Date.now() - started,
      error: err.name === 'AbortError' ? `timeout after ${timeout}ms` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** request() + JSON.parse, tolerating HTML error pages. */
async function requestJson(url, opts) {
  const res = await request(url, opts);
  if (!res.ok) return { ...res, json: null };
  try {
    return { ...res, json: JSON.parse(res.body) };
  } catch {
    return { ...res, ok: false, json: null, error: 'response was not valid JSON' };
  }
}

/**
 * Reachability check. We only care whether the host answers at all, so any
 * HTTP response -- including 401/403/404 -- counts as "reachable".
 */
async function reach(url, opts = {}) {
  const res = await request(url, { accept: '*/*', ...opts });
  return {
    reachable: res.status > 0,
    httpStatus: res.status,
    latency: res.latency,
    error: res.error,
  };
}

/**
 * Is *this machine* online?
 *
 * Without this check, losing wifi would paint every provider red and fire five
 * "outage" notifications -- the worst possible failure mode for an app whose
 * entire job is to be trusted about outages. We only ask this when provider
 * checks are already failing, so it costs nothing on the happy path.
 */
const CONTROL_HOSTS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://www.google.com/generate_204',
  'https://example.com/',
];

async function isOnline({ timeout = 4000 } = {}) {
  // Require a genuine 2xx/3xx here, not merely "something answered". A captive
  // portal or blocking proxy replies to everything, so treating any response
  // as proof of connectivity would defeat the check.
  const results = await Promise.all(
    CONTROL_HOSTS.map((u) =>
      reach(u, { timeout }).catch(() => ({ reachable: false, httpStatus: 0 }))
    )
  );
  return results.some((r) => r.httpStatus >= 200 && r.httpStatus < 400);
}

module.exports = { request, requestJson, reach, isOnline, USER_AGENT, CONTROL_HOSTS };
