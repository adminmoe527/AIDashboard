# Launch Kit

Everything pre-written for sharing AI Status. Each section is paste-ready —
no thinking required later. Venues that gate new accounts (HN, Reddit) just
need the account to exist for a while first; everything else works any time.

**The link everything points at:**
`https://github.com/adminmoe527/AIDashboard/releases/latest`

---

## Show HN (news.ycombinator.com/submit)

**Title:**
```
Show HN: A macOS menu bar monitor for AI provider outages (Claude, OpenAI, etc.)
```

**URL:** `https://github.com/adminmoe527/AIDashboard`

**First comment (post immediately after submitting):**
```
I kept losing work sessions to AI provider outages I only found out about
after hitting the wall — Claude was actually down for 3 hours the morning I
started building this, which felt like the universe endorsing the idea.

It's a menu bar "AI" indicator that goes yellow/red when any of 15 providers
degrades, with macOS notifications and a popover dashboard.

The part that turned out to be genuinely hard: not lying. Status pages lag
real incidents by 5-15 minutes and sometimes never admit them, so every
cycle also fires a keyless probe at each provider's real API host — a 401
means "alive and rejecting me", which is what healthy looks like. The probe
can only ever escalate a status, never reassure. And there's a pile of
false-alarm suppression that mattered more than I expected: HTTP 403 is
never "healthy" (your corporate proxy returns it exactly like a real API
would), your wifi dropping is not five simultaneous vendor outages, and
"Unknown" is a first-class state — the app says "I can't tell" instead of
guessing green.

Free, MIT, no account, no telemetry. Unsigned build (right-click > Open),
or build it yourself with one command if you don't trust binaries. Feedback
very welcome — it's my first shipped app.
```

---

## r/macapps (also works for r/SideProject)

**Title:**
```
I made a free menu bar app that watches 15 AI services (Claude, ChatGPT, Gemini…) so outages don't blindside you mid-project
```

**Body:**
```
I kept losing work sessions to AI provider outages I only discovered
*after* hitting the wall — Claude was down 3 hours the morning I started
building this. So: a menu bar "AI" indicator that turns yellow/red when any
provider degrades, with macOS notifications, a popover dashboard, and a
provider picker (15 supported).

It doesn't just mirror the official status pages (which lag 5–15 min and
sometimes lie) — it also pings the live APIs each cycle and escalates when
they disagree. And it's paranoid about false alarms: a proxy 403 or your
wifi dropping never fakes an outage.

Free, open source (MIT), no account, no telemetry.
Download: https://github.com/adminmoe527/AIDashboard/releases/latest

Feedback very welcome — it's my first shipped app.
```

---

## r/ClaudeAI variant

Same body as r/macapps, but open with:
```
After the last Claude outage caught me mid-project, I built the thing I
wished I'd had: ...
```

---

## LinkedIn

```
This weekend I shipped my first Mac app.

I kept losing work time to AI service outages I only discovered after
hitting the wall mid-project. The morning I started building the fix,
Claude went down for three hours — which felt like the universe agreeing
this should exist.

AI Status is a free, open-source menu bar app that watches 15 AI providers
(Claude, ChatGPT, Gemini, DeepSeek, and more) and warns you the moment one
degrades — before you start work, not after you lose it. It doesn't just
trust the official status pages, which lag real incidents by 5–15 minutes;
it independently pings the live APIs every cycle.

What I learned: the hard part of monitoring isn't detecting problems — it's
refusing to invent them. Corporate proxies, dropped wifi, and lying status
pages all try to trick a tool like this into false alarms, and most of the
engineering went into being honest about uncertainty.

It's free, MIT-licensed, and on GitHub:
https://github.com/adminmoe527/AIDashboard/releases/latest
```

---

## X / Twitter

```
Kept getting blindsided by AI outages mid-project (Claude was down 3h the
morning I started this). So I built a free Mac menu bar app that watches 15
AI providers and pings the live APIs — because status pages lag and
sometimes lie.

Free, open source, no account:
https://github.com/adminmoe527/AIDashboard/releases/latest
```

---

## macmenubar.com submission blurb

```
Name: AI Status
URL: https://github.com/adminmoe527/AIDashboard
Description: Free, open-source menu bar monitor for AI provider outages.
Watches Claude, ChatGPT, Gemini, DeepSeek, Grok and 10 more; colored "AI"
indicator, native notifications on degradation/recovery, live API probing
so it catches incidents before the official status pages admit them.
Price: Free (MIT)
```

---

## GitHub repo "About" settings (repo page → gear next to About)

```
Description: macOS menu bar monitor for AI provider outages — Claude, ChatGPT, Gemini, and 12 more
Website: https://github.com/adminmoe527/AIDashboard/releases/latest
Topics: macos, menubar, electron, ai, status-monitor, claude, openai, status-page
```

---

## Answers for predictable questions

- **"Why unsigned?"** — No Apple Developer subscription yet ($99/yr). It's
  MIT-licensed; build it yourself with one command if you don't trust the
  binary: `git clone https://github.com/adminmoe527/AIDashboard.git ~/AIDashboard && bash ~/AIDashboard/scripts/install-macos.sh`
- **"Why Electron for this?"** — Fastest path to shipping; zero runtime
  deps beyond Electron itself; a native Swift rewrite is a fair future step.
- **"Provider X shows Unknown"** — That provider's status page resists
  machine reading (some do, deliberately). The tile says so honestly instead
  of guessing, the live-API probe still covers real outages, and
  `npm run diagnose` shows exactly what failed. PRs with working endpoints
  welcome.
- **"Does it phone home?"** — No. It talks only to the providers' status
  pages and API hosts. No accounts, no analytics, nothing else.
