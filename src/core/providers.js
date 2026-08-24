'use strict';

/**
 * Provider catalog.
 *
 * Every provider lists its status sources in priority order. The monitor tries
 * them top to bottom and keeps the first one that yields a usable answer, so a
 * vendor silently migrating status platforms (which happens often) degrades to
 * a slower source instead of breaking the tile.
 *
 * Source kinds:
 *   statuspage - Atlassian Statuspage v2 JSON  (/api/v2/summary.json)
 *   instatus   - Instatus JSON                 (/summary.json)
 *   feed       - RSS/Atom incident feed        (parsed for *open* incidents)
 *   gcp        - Google Cloud incidents.json   (filtered to AI products)
 *
 * `probe` is an independent, keyless reachability check against the real API
 * host. Status pages are human-curated and typically lag an incident by 5-15
 * minutes; the probe is what catches trouble before you hit the wall.
 * An HTTP 400/401/405 from an API host is a healthy signal -- the server is
 * alive and rejecting our unauthenticated request, exactly as designed.
 * (403 is deliberately never healthy; see probe-rules.js.)
 *
 * `defaultEnabled` controls which providers a fresh install monitors; the
 * rest are offered in the picker (popover gear, or tray > Providers). For a
 * provider whose endpoints turn out to be wrong, the tile shows Unknown --
 * never a made-up green -- and `npm run diagnose` shows what actually failed.
 */

const CATALOG = [
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    defaultEnabled: true,
    homepage: 'https://status.claude.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.claude.com/api/v2/summary.json' },
      { kind: 'statuspage', url: 'https://status.anthropic.com/api/v2/summary.json' },
      { kind: 'feed', url: 'https://status.claude.com/history.rss' },
    ],
    probe: { url: 'https://api.anthropic.com/v1/messages', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    defaultEnabled: true,
    homepage: 'https://status.openai.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.openai.com/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.openai.com/summary.json' },
      { kind: 'feed', url: 'https://status.openai.com/feed.rss' },
      { kind: 'feed', url: 'https://status.openai.com/history.rss' },
    ],
    probe: { url: 'https://api.openai.com/v1/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    defaultEnabled: true,
    homepage: 'https://status.deepseek.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.deepseek.com/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.deepseek.com/summary.json' },
      { kind: 'feed', url: 'https://status.deepseek.com/history.rss' },
      { kind: 'feed', url: 'https://status.deepseek.com/history.atom' },
    ],
    probe: { url: 'https://api.deepseek.com/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    vendor: 'Moonshot AI',
    defaultEnabled: true,
    homepage: 'https://status.moonshot.cn/',
    sources: [
      { kind: 'statuspage', url: 'https://status.moonshot.cn/api/v2/summary.json' },
      { kind: 'statuspage', url: 'https://status.moonshot.ai/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.moonshot.cn/summary.json' },
      { kind: 'feed', url: 'https://status.moonshot.cn/history.rss' },
    ],
    probe: { url: 'https://api.moonshot.ai/v1/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'grok',
    name: 'Grok',
    vendor: 'xAI',
    defaultEnabled: true,
    homepage: 'https://status.x.ai/',
    // xAI runs Instatus and blocks the JSON endpoints, so the RSS feed is the
    // only machine-readable source. We still try JSON first in case that
    // changes.
    sources: [
      { kind: 'instatus', url: 'https://status.x.ai/summary.json' },
      { kind: 'statuspage', url: 'https://status.x.ai/api/v2/summary.json' },
      { kind: 'feed', url: 'https://status.x.ai/feed.xml' },
      { kind: 'feed', url: 'https://status.x.ai/history.rss' },
    ],
    probe: { url: 'https://api.x.ai/v1/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    defaultEnabled: true,
    homepage: 'https://status.cloud.google.com/',
    // Google publishes one machine-readable incident list for all of Google
    // Cloud; the gcp reader filters it to the Gemini / Vertex AI products.
    sources: [
      { kind: 'gcp', url: 'https://status.cloud.google.com/incidents.json' },
    ],
    // Google answers keyless requests with 403, which we refuse to count as
    // healthy, so this probe only contributes 5xx/unreachable escalation.
    probe: { url: 'https://generativelanguage.googleapis.com/v1beta/models', healthyHttp: [200, 400, 401] },
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    vendor: 'Perplexity',
    defaultEnabled: true,
    homepage: 'https://status.perplexity.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.perplexity.com/api/v2/summary.json' },
      { kind: 'statuspage', url: 'https://status.perplexity.ai/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.perplexity.com/summary.json' },
      { kind: 'feed', url: 'https://status.perplexity.com/history.rss' },
    ],
    probe: { url: 'https://api.perplexity.ai/chat/completions', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'github',
    name: 'GitHub + Copilot',
    vendor: 'GitHub',
    defaultEnabled: true,
    homepage: 'https://www.githubstatus.com/',
    sources: [
      { kind: 'statuspage', url: 'https://www.githubstatus.com/api/v2/summary.json' },
      { kind: 'feed', url: 'https://www.githubstatus.com/history.rss' },
    ],
    probe: { url: 'https://api.github.com/', healthyHttp: [200, 401] },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    defaultEnabled: true,
    homepage: 'https://status.cursor.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.cursor.com/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.cursor.com/summary.json' },
      { kind: 'feed', url: 'https://status.cursor.com/history.rss' },
    ],
    // No public keyless API endpoint worth probing; the status page decides.
    probe: null,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'OpenRouter',
    defaultEnabled: true,
    homepage: 'https://status.openrouter.ai/',
    sources: [
      { kind: 'instatus', url: 'https://status.openrouter.ai/summary.json' },
      { kind: 'statuspage', url: 'https://status.openrouter.ai/api/v2/summary.json' },
      { kind: 'feed', url: 'https://status.openrouter.ai/feed.xml' },
      { kind: 'feed', url: 'https://status.openrouter.ai/history.rss' },
    ],
    // The models list is public: a plain 200 is the expected healthy answer.
    probe: { url: 'https://openrouter.ai/api/v1/models', healthyHttp: [200, 400, 401] },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    vendor: 'Mistral AI',
    defaultEnabled: true,
    homepage: 'https://status.mistral.ai/',
    sources: [
      { kind: 'statuspage', url: 'https://status.mistral.ai/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.mistral.ai/summary.json' },
      { kind: 'feed', url: 'https://status.mistral.ai/history.rss' },
    ],
    probe: { url: 'https://api.mistral.ai/v1/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'groq',
    name: 'Groq',
    vendor: 'Groq',
    defaultEnabled: true,
    homepage: 'https://groqstatus.com/',
    sources: [
      { kind: 'statuspage', url: 'https://groqstatus.com/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://groqstatus.com/summary.json' },
      { kind: 'feed', url: 'https://groqstatus.com/history.rss' },
    ],
    probe: { url: 'https://api.groq.com/openai/v1/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'together',
    name: 'Together AI',
    vendor: 'Together AI',
    defaultEnabled: true,
    homepage: 'https://status.together.ai/',
    sources: [
      { kind: 'statuspage', url: 'https://status.together.ai/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.together.ai/summary.json' },
      { kind: 'feed', url: 'https://status.together.ai/history.rss' },
    ],
    probe: { url: 'https://api.together.xyz/v1/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    vendor: 'ElevenLabs',
    defaultEnabled: true,
    homepage: 'https://status.elevenlabs.io/',
    sources: [
      { kind: 'statuspage', url: 'https://status.elevenlabs.io/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.elevenlabs.io/summary.json' },
      { kind: 'feed', url: 'https://status.elevenlabs.io/history.rss' },
    ],
    probe: { url: 'https://api.elevenlabs.io/v1/models', healthyHttp: [400, 401, 405] },
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    vendor: 'Hugging Face',
    defaultEnabled: true,
    homepage: 'https://status.huggingface.co/',
    sources: [
      { kind: 'statuspage', url: 'https://status.huggingface.co/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.huggingface.co/summary.json' },
      { kind: 'feed', url: 'https://status.huggingface.co/history.rss' },
    ],
    probe: { url: 'https://huggingface.co/api/models?limit=1', healthyHttp: [200, 400, 401] },
  },
];

/** The default set a fresh install monitors. */
const PROVIDERS = CATALOG.filter((p) => p.defaultEnabled);

function byId(id) {
  return CATALOG.find((p) => p.id === id) || null;
}

module.exports = { CATALOG, PROVIDERS, byId };
