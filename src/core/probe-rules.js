'use strict';

const { STATUS } = require('./state');

/**
 * Interpret the HTTP status of a keyless probe against a provider's API host.
 *
 * The guiding rule: only treat a response as healthy when it could only have
 * come from the real API. Anything a middlebox could have produced is
 * `unknown`, never `operational` -- a false green defeats the whole point of
 * the app.
 *
 * 401 / 400 / 405  the API itself answered and rejected our keyless request.
 *                  This is the strongest cheap liveness signal available.
 * 403              AMBIGUOUS. Real APIs return it, but so does every corporate
 *                  proxy, Cloudflare WAF and geo-block. Never counts as
 *                  healthy.
 * 5xx              the origin is in trouble.
 * 429              alive but rate limiting us.
 * 0                nothing answered at all.
 */
function interpretProbe(httpStatus, { healthyHttp, latency, error } = {}) {
  if (!httpStatus) {
    return { status: STATUS.OUTAGE, httpStatus: 0, latency, note: error || 'unreachable' };
  }

  if (httpStatus === 403) {
    return {
      status: STATUS.UNKNOWN,
      httpStatus,
      latency,
      note: 'blocked with 403 (proxy, VPN, WAF or region lock) - cannot tell',
    };
  }

  const healthy = healthyHttp && healthyHttp.length ? healthyHttp : [200, 401, 405];
  if (healthy.includes(httpStatus) || (httpStatus >= 200 && httpStatus < 300)) {
    return { status: STATUS.OPERATIONAL, httpStatus, latency, note: null };
  }

  if (httpStatus >= 500) {
    return { status: STATUS.OUTAGE, httpStatus, latency, note: `server error ${httpStatus}` };
  }
  if (httpStatus === 429) {
    return { status: STATUS.DEGRADED, httpStatus, latency, note: 'rate limited' };
  }
  if (httpStatus === 408) {
    return { status: STATUS.DEGRADED, httpStatus, latency, note: 'request timeout' };
  }

  // Host answered with something we don't recognise. The edge is alive, but
  // this is not evidence of health.
  return { status: STATUS.UNKNOWN, httpStatus, latency, note: `unexpected HTTP ${httpStatus}` };
}

module.exports = { interpretProbe };
