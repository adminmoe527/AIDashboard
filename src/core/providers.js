'use strict';

/**
 * Provider registry.
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
 *
 * `probe` is an independent, keyless reachability check against the real API
 * host. Status pages are human-curated and typically lag an incident by 5-15
 * minutes; the probe is what catches trouble before you hit the wall.
 * An HTTP 401/403 from an API host is a healthy signal -- it means the server
 * is alive and rejecting our unauthenticated request, exactly as designed.
 */

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    homepage: 'https://status.claude.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.claude.com/api/v2/summary.json' },
      { kind: 'statuspage', url: 'https://status.anthropic.com/api/v2/summary.json' },
      { kind: 'feed', url: 'https://status.claude.com/history.rss' },
    ],
    probe: { url: 'https://api.anthropic.com/v1/messages', healthyHttp: [400, 401, 405] },
    // Components worth alerting on. Substring match, case-insensitive.
    keyComponents: ['api', 'claude code', 'claude.ai'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    homepage: 'https://status.openai.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.openai.com/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.openai.com/summary.json' },
      { kind: 'feed', url: 'https://status.openai.com/feed.rss' },
      { kind: 'feed', url: 'https://status.openai.com/history.rss' },
    ],
    probe: { url: 'https://api.openai.com/v1/models', healthyHttp: [400, 401, 405] },
    keyComponents: ['api', 'chat'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    homepage: 'https://status.deepseek.com/',
    sources: [
      { kind: 'statuspage', url: 'https://status.deepseek.com/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.deepseek.com/summary.json' },
      { kind: 'feed', url: 'https://status.deepseek.com/history.rss' },
    ],
    probe: { url: 'https://api.deepseek.com/models', healthyHttp: [400, 401, 405] },
    keyComponents: ['api', 'chat'],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    vendor: 'Moonshot AI',
    homepage: 'https://status.moonshot.cn/',
    sources: [
      { kind: 'statuspage', url: 'https://status.moonshot.cn/api/v2/summary.json' },
      { kind: 'statuspage', url: 'https://status.moonshot.ai/api/v2/summary.json' },
      { kind: 'instatus', url: 'https://status.moonshot.cn/summary.json' },
      { kind: 'feed', url: 'https://status.moonshot.cn/history.rss' },
    ],
    probe: { url: 'https://api.moonshot.ai/v1/models', healthyHttp: [400, 401, 405] },
    keyComponents: ['api', 'kimi'],
  },
  {
    id: 'grok',
    name: 'Grok',
    vendor: 'xAI',
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
    keyComponents: ['api', 'grok'],
  },
];

function byId(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

module.exports = { PROVIDERS, byId };
