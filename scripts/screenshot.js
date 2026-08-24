'use strict';

/**
 * Renders docs/screenshot.png from the real renderer HTML with mocked data.
 * Needs playwright-core and a Chromium binary:
 *   npm i --no-save playwright-core && node scripts/screenshot.js
 * (Adjust executablePath below to your Chromium if not using the default.)
 */
const { chromium } = require('playwright-core');
const path = require('path');

const snapshot = {
  at: new Date().toISOString(),
  offline: false,
  overall: 'degraded',
  providers: [
    { id: 'claude', name: 'Claude', vendor: 'Anthropic', homepage: 'https://status.claude.com/', status: 'operational', detail: 'All Systems Operational', source: { kind: 'statuspage' }, probe: { latency: 84 }, incidents: [] },
    { id: 'openai', name: 'OpenAI', vendor: 'OpenAI', homepage: 'https://status.openai.com/', status: 'operational', detail: 'All Systems Operational', source: { kind: 'statuspage' }, probe: { latency: 132 }, incidents: [] },
    { id: 'gemini', name: 'Gemini', vendor: 'Google', homepage: 'https://status.cloud.google.com/', status: 'operational', detail: 'No open incidents', source: { kind: 'gcp' }, probe: { latency: 117 }, incidents: [] },
    { id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek', homepage: 'https://status.deepseek.com/', status: 'operational', detail: 'No open incidents in the feed (last 48h)', source: { kind: 'feed' }, probe: { latency: 421 }, incidents: [] },
    { id: 'elevenlabs', name: 'ElevenLabs', vendor: 'ElevenLabs', homepage: 'https://status.elevenlabs.io/', status: 'degraded', detail: 'Partially Degraded Service', source: { kind: 'statuspage' }, probe: { latency: 208 }, incidents: [{ name: 'Elevated latency on speech synthesis' }] },
    { id: 'grok', name: 'Grok', vendor: 'xAI', homepage: 'https://status.x.ai/', status: 'operational', detail: 'No open incidents', source: { kind: 'feed' }, probe: { latency: 156 }, incidents: [] },
    { id: 'kimi', name: 'Kimi', vendor: 'Moonshot AI', homepage: 'https://status.moonshot.cn/', status: 'operational', detail: 'All Systems Operational', source: { kind: 'statuspage' }, probe: { latency: 348 }, incidents: [] },
    { id: 'perplexity', name: 'Perplexity', vendor: 'Perplexity', homepage: 'https://status.perplexity.com/', status: 'operational', detail: 'UP', source: { kind: 'instatus' }, probe: { latency: 121 }, incidents: [] },
  ],
};

const settings = {
  intervalMs: 60000, notifications: true, launchAtLogin: true, loginItemSupported: true,
  catalog: [],
};

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({
    viewport: { width: 380, height: 640 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  await page.addInitScript(`(() => {
    window.aistatus = {
      getSnapshot: async () => (${JSON.stringify(snapshot)}),
      getSettings: async () => (${JSON.stringify(settings)}),
      setSettings: async (p) => (${JSON.stringify(settings)}),
      refresh: async () => (${JSON.stringify(snapshot)}),
      openUrl: async () => true,
      quit: async () => {},
      onSnapshot: () => () => {},
      onSettings: () => () => {},
    };
  })()`);
  await page.goto('file://' + path.join(__dirname, 'src', 'electron', 'renderer', 'index.html'));
  await page.waitForSelector('.tile');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, 'docs', 'screenshot.png') });
  await browser.close();
  console.log('screenshot saved');
})().catch((e) => { console.error(e); process.exit(1); });
