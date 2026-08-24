# AI Status

A tiny macOS menu bar app (plus a CLI) that watches the health of the AI
services you depend on — **Claude, OpenAI, Gemini, DeepSeek, Kimi, Grok,
Perplexity, Mistral, Groq, Together, OpenRouter, ElevenLabs, Hugging Face,
GitHub/Copilot, and Cursor** — so you find out about degradations *before*
you hit the wall, not after.

- Lives in the **menu bar**, no Dock icon, runs quietly in the background
- An **"AI" wordmark** in the menu bar, colored by the **worst current
  status** (green = all good, yellow = degraded, red = outage, grey = unknown)
- **Pick your providers**: checkboxes in the settings panel (or right-click
  the menu bar icon → Providers) — all 15 are on by default, uncheck what you
  don't use
- Click the dot for a **popover dashboard** with per-provider detail and
  active incidents; click a tile to open that provider's status page
- **macOS notifications** when a provider degrades or recovers
- Polls every 60 seconds by default (configurable 30s–5m)
- Zero runtime dependencies — the only packages are Electron itself and
  electron-builder for packaging

## Quick start

Requires Node 20+ (tested on 22).

```bash
git clone https://github.com/adminmoe527/AIDashboard.git
cd AIDashboard
npm install
npm start          # the dot appears in your menu bar
```

### Try it without Electron

The same monitoring engine has a terminal front-end:

```bash
npm run check      # one-shot status table
npm run watch      # live table, refreshes every 60s
npm run diagnose   # tests every status endpoint and the API probes
node src/cli/check.js --json   # machine-readable snapshot
```

`npm run check` exits `2` when anything is not operational, so you can use it
in scripts: `npm run check || say "an AI provider is having trouble"`.

## Install it as a real background app

**One command** (paste into Terminal on your Mac — needs Node 20+, e.g. `brew install node`):

```bash
git clone -b claude/ai-status-dashboard-sbs9uv https://github.com/adminmoe527/AIDashboard.git ~/AIDashboard && bash ~/AIDashboard/scripts/install-macos.sh
```

It clones the repo, builds the app, installs it to `/Applications`, clears the
Gatekeeper quarantine, and launches it. Re-run the same script any time to
update. Prefer to do it manually?

```bash
npm run dist
```

This produces `dist/AI Status-<version>-<arch>.dmg`. Open it, drag **AI
Status** to Applications, and launch it. The app:

- runs as a **menu bar accessory** (`LSUIElement`) — no Dock icon, no window
  clutter;
- keeps polling in the background as long as it runs;
- can start automatically: right-click the menu bar dot → **Start at Login**
  (or add it in System Settings → General → Login Items). This toggle is only
  available in the installed app — in `npm start` dev mode it would register
  the bare Electron binary, so it's disabled there.

> **Unsigned app note:** the build is not code-signed, so the first launch
> needs a right-click → Open → Open (or `xattr -dr com.apple.quarantine
> "/Applications/AI Status.app"`). After that it opens normally.

## How status is decided

Each provider is checked two ways on every cycle, and the app is deliberately
paranoid about **false greens**:

1. **Status page** — sources are tried in priority order until one answers:

   Every provider lists its candidate endpoints (Atlassian Statuspage JSON,
   Instatus JSON, RSS/Atom feeds — Google gets a dedicated reader for its
   `incidents.json`) in [`src/core/providers.js`](src/core/providers.js).
   Notable quirks: Claude's page moved to `status.claude.com`; xAI blocks its
   JSON endpoints so Grok reads RSS; Kimi lives at `status.moonshot.cn`;
   Gemini status is filtered out of the all-of-Google-Cloud incident list.

2. **Live probe** — a keyless request to the provider's real API host
   (`api.anthropic.com`, `api.openai.com`, …). A `401`/`400`/`405` means the
   API is alive and rejecting an unauthenticated call, which is exactly what
   healthy looks like. The probe can only ever **escalate** a status (status
   pages typically lag incidents by 5–15 minutes); it never paints a
   yellow/red page green.

Rules that keep the signal honest:

- **HTTP 403 is never "healthy"** — corporate proxies, VPNs, and WAFs return
  403 exactly like a real API would, so it grades as *Unknown*, not
  *Operational*. And an ambiguous probe never overrides a readable status
  page — a proxied network doesn't grey out perfectly good tiles.
- **Your wifi dropping is not a provider outage.** If every provider fails at
  once, the app checks its own connectivity against neutral hosts and shows
  an *offline* banner instead of five fake outages — and if everything fails
  right after a healthy cycle, it re-checks once before believing it, so a
  wifi roam that heals mid-cycle can't cause a notification storm.
- **No reachable source ⇒ *Unknown*, never *Operational*.**
- **A probe-only outage needs two consecutive failing cycles before it
  notifies** (a single dropped connection isn't proof — the tile still
  updates immediately; only the alert waits). Page-confirmed incidents alert
  on the first cycle.
- **A blind spot never mutes an alert.** Transitions are tracked against the
  last *definitive* status, so a status page that times out for one cycle
  mid-incident still produces an *Operational → Outage* notification when it
  comes back — never silence.
- **RSS fallback reads incidents the way status pages write them**: entries
  are grouped per incident, only the newest update counts (recovery words in
  older update history can't hide a live incident), unresolved incidents stay
  open for up to 48h without fresh updates, and in-progress maintenance is
  *Maintenance*, not an outage.

## Fixing a broken provider

Vendors move status platforms without notice. When a tile is stuck on
*Unknown*:

```bash
npm run diagnose
```

This hits every configured source URL and probe for every provider and prints
exactly what worked and what didn't. To fix one, edit the provider's `sources`
list in [`src/core/providers.js`](src/core/providers.js) — the reader kinds
are `statuspage` (Atlassian `/api/v2/summary.json`), `instatus`
(`/summary.json`), and `feed` (RSS/Atom). Re-run the diagnose to confirm.

## Project layout

```
src/core/        engine (no Electron) — providers, adapters, probe rules, monitor
  providers.js   the provider registry: status sources + API probes
  adapters.js    Statuspage / Instatus / RSS readers
  probe-rules.js how probe HTTP codes are graded (the false-green rules)
  monitor.js     polling loop, change detection, offline detection
src/cli/         terminal front-end (check / watch / diagnose / json)
src/electron/    menu bar app: tray, popover window, notifications
scripts/         icon generator (dependency-free PNG encoder)
test/            offline parser tests + e2e tests over a local HTTP server
```

## Settings

Stored at `~/Library/Application Support/AI Status/settings.json`; editable
from the popover's gear or the tray's right-click menu:

| Setting | Default |
|---|---|
| Check interval | 60s |
| Notifications | on |
| Start at login | off |
| Providers | all 15 enabled |

## Development

```bash
npm test           # 37 offline tests: parsers, grading, alerting, e2e over localhost
npm run icons      # regenerate tray + app icons
npm run pack       # unpacked .app in dist/mac for quick inspection
node src/cli/check.js --providers=claude,openai   # CLI subset
```

## Releasing

Pushing a version tag builds downloadable installers on GitHub's macOS
runners and attaches them to a GitHub Release — no Node required for the
people installing them:

```bash
git tag v1.1.0 && git push origin v1.1.0
```

The release carries unsigned `.dmg` files for Apple Silicon and Intel; first
launch needs right-click → Open (see the unsigned-app note above).

## License

MIT
