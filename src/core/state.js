'use strict';

/**
 * Canonical status vocabulary.
 *
 * `unknown` is deliberately a first-class state. When every probe for a
 * provider fails we surface `unknown` rather than assuming the service is
 * healthy -- a false green is the exact failure mode this app exists to
 * prevent.
 */
const STATUS = {
  OPERATIONAL: 'operational',
  MAINTENANCE: 'maintenance',
  DEGRADED: 'degraded',
  OUTAGE: 'outage',
  UNKNOWN: 'unknown',
};

/** Higher rank == more attention-worthy. Used to roll many signals into one. */
const RANK = {
  [STATUS.OPERATIONAL]: 0,
  [STATUS.MAINTENANCE]: 1,
  [STATUS.UNKNOWN]: 2,
  [STATUS.DEGRADED]: 3,
  [STATUS.OUTAGE]: 4,
};

const LABEL = {
  [STATUS.OPERATIONAL]: 'Operational',
  [STATUS.MAINTENANCE]: 'Maintenance',
  [STATUS.UNKNOWN]: 'Unknown',
  [STATUS.DEGRADED]: 'Degraded',
  [STATUS.OUTAGE]: 'Outage',
};

const COLOR = {
  [STATUS.OPERATIONAL]: '#2ea043',
  [STATUS.MAINTENANCE]: '#3b82f6',
  [STATUS.UNKNOWN]: '#8b949e',
  [STATUS.DEGRADED]: '#d29922',
  [STATUS.OUTAGE]: '#f85149',
};

function rank(status) {
  return RANK[status] ?? RANK[STATUS.UNKNOWN];
}

/** Returns the most severe status in the list. */
function worst(statuses) {
  let out = STATUS.OPERATIONAL;
  let seen = false;
  for (const s of statuses) {
    if (!s) continue;
    seen = true;
    if (rank(s) > rank(out)) out = s;
  }
  return seen ? out : STATUS.UNKNOWN;
}

/**
 * Map an Atlassian Statuspage `indicator` (none/minor/major/critical/
 * maintenance) onto our vocabulary.
 */
function fromStatuspageIndicator(indicator) {
  switch (String(indicator || '').toLowerCase()) {
    case 'none': return STATUS.OPERATIONAL;
    case 'minor': return STATUS.DEGRADED;
    case 'major': return STATUS.OUTAGE;
    case 'critical': return STATUS.OUTAGE;
    case 'maintenance': return STATUS.MAINTENANCE;
    default: return STATUS.UNKNOWN;
  }
}

/**
 * Map an Atlassian Statuspage component `status` onto our vocabulary.
 * Instatus reuses most of these strings, plus a few of its own.
 */
function fromComponentStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'operational':
    case 'up':
    case 'available':
      return STATUS.OPERATIONAL;
    case 'degraded_performance':
    case 'degradedperformance':
    case 'partial_outage':
    case 'partialoutage':
    case 'partial':
    case 'hasissues':
      return STATUS.DEGRADED;
    case 'major_outage':
    case 'majoroutage':
    case 'down':
      return STATUS.OUTAGE;
    case 'under_maintenance':
    case 'undermaintenance':
    case 'maintenance':
      return STATUS.MAINTENANCE;
    default:
      return STATUS.UNKNOWN;
  }
}

/**
 * Fixed-size ring buffer of recent samples, used to draw the sparkline and to
 * answer "was this already broken last time I looked?".
 */
class History {
  constructor(limit = 240) {
    this.limit = limit;
    this.items = [];
  }
  push(entry) {
    this.items.push(entry);
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
  }
  toArray() {
    return this.items.slice();
  }
}

module.exports = { STATUS, RANK, LABEL, COLOR, rank, worst, fromStatuspageIndicator, fromComponentStatus, History };
