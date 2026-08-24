#!/usr/bin/env node
'use strict';

/**
 * Terminal front-end for the same core the menu bar app uses.
 *
 *   node src/cli/check.js              one-shot table
 *   node src/cli/check.js --watch      refresh in place
 *   node src/cli/check.js --diagnose   probe every endpoint and report which
 *                                      ones actually answer
 *   node src/cli/check.js --json       machine-readable
 */

const { PROVIDERS } = require('../core/providers');
const { READERS, runProbe } = require('../core/adapters');
const { Monitor, checkAll } = require('../core/monitor');
const { STATUS, LABEL } = require('../core/state');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  blue: '\x1b[34m', grey: '\x1b[90m',
};
const useColor = process.stdout.isTTY && !has('--no-color');
const c = (color, s) => (useColor ? `${C[color]}${s}${C.reset}` : s);

const DOT = {
  [STATUS.OPERATIONAL]: () => c('green', '*'),
  [STATUS.DEGRADED]: () => c('yellow', '!'),
  [STATUS.OUTAGE]: () => c('red', 'X'),
  [STATUS.MAINTENANCE]: () => c('blue', 'M'),
  [STATUS.UNKNOWN]: () => c('grey', '?'),
};

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function render(snapshot) {
  const lines = [];
  lines.push('');
  lines.push(`  ${c('bold', 'AI Status')}  ${c('grey', new Date(snapshot.at).toLocaleTimeString())}`);
  lines.push('');
  if (snapshot.offline) {
    lines.push(`  ${c('yellow', 'This machine appears to be offline - provider status is unknown.')}`);
    lines.push('');
  }
  for (const p of snapshot.providers) {
    const dot = (DOT[p.status] || DOT[STATUS.UNKNOWN])();
    const via = p.source ? p.source.kind : 'none';
    const lat = p.probe && p.probe.latency != null ? `${p.probe.latency}ms` : '';
    lines.push(
      `  ${dot}  ${pad(p.name, 10)} ${pad(LABEL[p.status], 13)} ${c('grey', pad(via, 11))} ${c('grey', lat)}`
    );
    if (p.detail && p.status !== STATUS.OPERATIONAL) {
      lines.push(`     ${c('grey', truncate(p.detail, 68))}`);
    }
    for (const inc of (p.incidents || []).slice(0, 2)) {
      lines.push(`     ${c('grey', '- ' + truncate(inc.name, 66))}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * --diagnose: hit every configured source URL for every provider and report
 * exactly which ones work from this machine. Vendors move status platforms
 * without notice, so this is the tool for finding out that a source went stale.
 */
async function diagnose() {
  console.log(`\n  ${c('bold', 'Endpoint diagnostic')}\n`);
  let anyFail = false;

  for (const p of PROVIDERS) {
    console.log(`  ${c('bold', p.name)} ${c('grey', '(' + p.vendor + ')')}`);
    let firstWorking = null;

    for (const s of p.sources) {
      const reader = READERS[s.kind];
      let r;
      const t0 = Date.now();
      try {
        r = await reader(s.url);
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      const ms = Date.now() - t0;
      if (r.ok) {
        if (!firstWorking) firstWorking = s;
        const extra =
          (r.components && r.components.length ? `${r.components.length} components` : '') ||
          (r.description || '');
        console.log(`    ${c('green', 'ok  ')} ${pad(s.kind, 11)} ${c('grey', s.url)}`);
        console.log(`         ${c('grey', `-> ${LABEL[r.overall]}  ${extra}  ${ms}ms`)}`);
      } else {
        console.log(`    ${c('red', 'fail')} ${pad(s.kind, 11)} ${c('grey', s.url)}`);
        console.log(`         ${c('grey', `-> ${r.error}  ${ms}ms`)}`);
      }
    }

    const probe = await runProbe(p.probe);
    if (probe) {
      const good = probe.status === STATUS.OPERATIONAL;
      console.log(
        `    ${good ? c('green', 'ok  ') : c('yellow', 'warn')} ${pad('probe', 11)} ${c('grey', p.probe.url)}`
      );
      console.log(
        `         ${c('grey', `-> HTTP ${probe.httpStatus}  ${LABEL[probe.status]}  ${probe.latency}ms${probe.note ? '  ' + probe.note : ''}`)}`
      );
    }

    if (!firstWorking) {
      anyFail = true;
      console.log(`    ${c('red', 'NO WORKING STATUS SOURCE')} - this provider will show as Unknown.`);
      console.log(`    ${c('grey', 'Fix: edit src/core/providers.js and add a working source URL.')}`);
    }
    console.log('');
  }

  if (anyFail) {
    console.log(`  ${c('yellow', 'One or more providers have no working status source.')}`);
    console.log(`  ${c('grey', 'See README "Fixing a broken provider".')}\n`);
    process.exitCode = 1;
  } else {
    console.log(`  ${c('green', 'All providers have at least one working status source.')}\n`);
  }
}

async function main() {
  if (has('--diagnose') || has('-d')) return diagnose();

  if (has('--watch') || has('-w')) {
    const m = new Monitor({ intervalMs: 60_000 });
    // Keep a short log of recent transitions; rendering them as part of the
    // table means they survive the screen clear on the next refresh.
    const recentChanges = [];
    m.on('change', (ch) => {
      recentChanges.push(
        `${new Date().toLocaleTimeString()}  ${ch.provider.name}: ${LABEL[ch.from]} -> ${LABEL[ch.to]}`
      );
      if (recentChanges.length > 5) recentChanges.shift();
    });
    m.on('update', (snap) => {
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(render(snap));
      if (recentChanges.length) {
        process.stdout.write(`  ${c('bold', 'Recent changes')}\n`);
        for (const line of recentChanges) process.stdout.write(`  ${c('yellow', line)}\n`);
        process.stdout.write('\n');
      }
      process.stdout.write(`  ${c('grey', 'Ctrl-C to exit. Refreshing every 60s.')}\n`);
    });
    m.start();
    // Keep the process alive; Monitor unrefs its timer so hold an explicit ref.
    setInterval(() => {}, 1 << 30);
    return;
  }

  const { buildSnapshot } = require('../core/monitor');
  const results = await checkAll();
  const snapshot = await buildSnapshot(results);

  if (has('--json')) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(render(snapshot));
  if (snapshot.overall !== STATUS.OPERATIONAL) process.exitCode = 2;
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
