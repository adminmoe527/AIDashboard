'use strict';

/**
 * End-to-end tests over a local HTTP server that serves real payload shapes
 * (Statuspage v2, Instatus, RSS). Exercises the full path the app uses:
 * source fallback order, probe reconciliation, and degraded/outage grading.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { checkProvider } = require('../src/core/monitor');
const { readFeed, readGcp } = require('../src/core/adapters');
const { STATUS } = require('../src/core/state');

/* ------------------------------- fixtures ------------------------------- */

const SP_GREEN = {
  page: { id: 'x', name: 'Example' },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    { name: 'API', status: 'operational' },
    { name: 'Chat', status: 'operational' },
  ],
  incidents: [],
  scheduled_maintenances: [],
};

const SP_MINOR = {
  page: { id: 'x', name: 'Example' },
  status: { indicator: 'minor', description: 'Partially Degraded Service' },
  components: [
    { name: 'API', status: 'degraded_performance' },
    { name: 'Chat', status: 'operational' },
  ],
  incidents: [
    {
      name: 'Elevated error rates on the API',
      status: 'investigating',
      impact: 'minor',
      updated_at: new Date().toISOString(),
      shortlink: 'https://stspg.io/abc',
      incident_updates: [{ body: '<p>We are investigating.</p>' }],
    },
  ],
  scheduled_maintenances: [],
};

const INSTATUS_ISSUES = {
  page: { name: 'Example', url: 'https://example.dev', status: 'HASISSUES' },
  activeIncidents: [
    {
      name: 'API returning 5xx',
      status: 'INVESTIGATING',
      impact: 'MAJOROUTAGE',
      updated_at: new Date().toISOString(),
      url: 'https://example.dev/incident/1',
    },
  ],
  activeMaintenances: [],
};

function rssWithOpenIncident() {
  const recent = new Date(Date.now() - 20 * 60 * 1000).toUTCString();
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
    <item>
      <title>Investigating elevated latency</title>
      <description>We are investigating elevated latency on the API.</description>
      <pubDate>${recent}</pubDate>
      <link>https://status.example.dev/i/1</link>
    </item>
  </channel></rss>`;
}

/* ------------------------------- helpers -------------------------------- */

function serve(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const route = routes[req.url.split('?')[0]];
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>not found</html>');
        return;
      }
      route(req, res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const json = (obj) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const xml = (body) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/rss+xml' });
  res.end(body);
};
const httpStatus = (code) => (req, res) => {
  res.writeHead(code);
  res.end();
};

function providerAt(base, { sources, probe }) {
  return {
    id: 'test',
    name: 'Test',
    vendor: 'Test',
    homepage: base,
    sources,
    probe,
    keyComponents: ['api'],
  };
}

async function withServer(routes, fn) {
  const srv = await serve(routes);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    return await fn(base);
  } finally {
    srv.close();
  }
}

/* --------------------------------- tests -------------------------------- */

test('healthy statuspage + healthy probe -> operational', async () => {
  await withServer(
    { '/summary.json': json(SP_GREEN), '/probe': httpStatus(401) },
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [{ kind: 'statuspage', url: `${base}/summary.json` }],
          probe: { url: `${base}/probe`, healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.status, STATUS.OPERATIONAL);
      assert.equal(r.source.kind, 'statuspage');
      assert.equal(r.components.length, 2);
    }
  );
});

test('minor statuspage incident -> degraded with incident details', async () => {
  await withServer(
    { '/summary.json': json(SP_MINOR), '/probe': httpStatus(401) },
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [{ kind: 'statuspage', url: `${base}/summary.json` }],
          probe: { url: `${base}/probe`, healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.status, STATUS.DEGRADED);
      assert.equal(r.incidents.length, 1);
      assert.match(r.incidents[0].name, /Elevated error rates/);
      // HTML stripped from the incident update body.
      assert.ok(!r.incidents[0].body.includes('<p>'));
    }
  );
});

test('instatus payload with an active major incident -> graded from page status', async () => {
  await withServer(
    { '/summary.json': json(INSTATUS_ISSUES), '/probe': httpStatus(401) },
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [{ kind: 'instatus', url: `${base}/summary.json` }],
          probe: { url: `${base}/probe`, healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.status, STATUS.DEGRADED); // page says HASISSUES
      assert.equal(r.incidents.length, 1);
      assert.equal(r.source.kind, 'instatus');
    }
  );
});

test('dead JSON source falls through to the RSS feed', async () => {
  await withServer(
    {
      // no /summary.json route -> 404 HTML
      '/feed.xml': xml(rssWithOpenIncident()),
      '/probe': httpStatus(401),
    },
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [
            { kind: 'statuspage', url: `${base}/summary.json` },
            { kind: 'feed', url: `${base}/feed.xml` },
          ],
          probe: { url: `${base}/probe`, healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.source.kind, 'feed');
      assert.equal(r.status, STATUS.DEGRADED);
      assert.equal(r.attempts[0].ok, false);
      assert.equal(r.attempts[1].ok, true);
    }
  );
});

test('green status page but 500ing API host -> probe escalates to outage', async () => {
  await withServer(
    { '/summary.json': json(SP_GREEN), '/probe': httpStatus(503) },
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [{ kind: 'statuspage', url: `${base}/summary.json` }],
          probe: { url: `${base}/probe`, healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.status, STATUS.OUTAGE);
      assert.equal(r.probeEscalated, true);
      assert.match(r.detail, /live probe/);
    }
  );
});

test('degraded page never gets downgraded by a healthy probe', async () => {
  await withServer(
    { '/summary.json': json(SP_MINOR), '/probe': httpStatus(200) },
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [{ kind: 'statuspage', url: `${base}/summary.json` }],
          probe: { url: `${base}/probe`, healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.status, STATUS.DEGRADED);
      assert.ok(!r.probeEscalated);
    }
  );
});

test('all sources dead + probe blocked with 403 -> unknown, not outage and not green', async () => {
  await withServer(
    { '/probe': httpStatus(403) },
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [{ kind: 'statuspage', url: `${base}/summary.json` }],
          probe: { url: `${base}/probe`, healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.status, STATUS.UNKNOWN);
    }
  );
});

test('all sources dead + probe connection-refused -> outage', async () => {
  // Point the probe at a port nothing listens on.
  await withServer(
    {},
    async (base) => {
      const r = await checkProvider(
        providerAt(base, {
          sources: [{ kind: 'statuspage', url: `${base}/summary.json` }],
          probe: { url: 'http://127.0.0.1:1/nope', healthyHttp: [400, 401, 405] },
        })
      );
      assert.equal(r.status, STATUS.OUTAGE);
      assert.match(r.detail, /unreachable/i);
    }
  );
});

/* --------------------------- feed window rules --------------------------- */

function rssItems(items) {
  return (
    '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>' +
    items
      .map(
        (i) =>
          `<item><title>${i.title}</title><description>${i.desc}</description>` +
          `<pubDate>${i.date.toUTCString()}</pubDate>` +
          (i.link ? `<link>${i.link}</link>` : '') +
          '</item>'
      )
      .join('') +
    '</channel></rss>'
  );
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

test('an unresolved incident 20h old is still an open incident', async () => {
  const body = rssItems([
    {
      title: 'Elevated API error rates',
      desc: 'Investigating - We are seeing elevated error rates.',
      date: hoursAgo(20),
      link: 'https://s.example/i/1',
    },
  ]);
  await withServer({ '/feed.xml': xml(body) }, async (base) => {
    const r = await readFeed(`${base}/feed.xml`);
    assert.equal(r.ok, true);
    assert.equal(r.overall, STATUS.DEGRADED);
    assert.equal(r.incidents.length, 1);
  });
});

test('update-per-entry feeds: the newest update of an incident wins', async () => {
  // Same incident link: an old "Investigating" update and a newer "Resolved".
  const body = rssItems([
    {
      title: 'Elevated API error rates',
      desc: 'Investigating - We are seeing elevated error rates.',
      date: hoursAgo(5),
      link: 'https://s.example/i/1',
    },
    {
      title: 'Elevated API error rates',
      desc: 'Resolved - This incident has been resolved.',
      date: hoursAgo(2),
      link: 'https://s.example/i/1',
    },
  ]);
  await withServer({ '/feed.xml': xml(body) }, async (base) => {
    const r = await readFeed(`${base}/feed.xml`);
    assert.equal(r.overall, STATUS.OPERATIONAL);
    assert.equal(r.incidents.length, 0);
  });
});

test('in-progress maintenance grades as maintenance, future maintenance is ignored', async () => {
  const inProgress = rssItems([
    {
      title: 'Scheduled maintenance on the API',
      desc: 'In progress - Scheduled maintenance is currently in progress.',
      date: hoursAgo(1),
      link: 'https://s.example/m/1',
    },
  ]);
  await withServer({ '/feed.xml': xml(inProgress) }, async (base) => {
    const r = await readFeed(`${base}/feed.xml`);
    assert.equal(r.overall, STATUS.MAINTENANCE);
  });

  const announced = rssItems([
    {
      title: 'Scheduled maintenance on the API',
      desc: 'Scheduled - We will perform scheduled maintenance this weekend.',
      date: hoursAgo(1),
      link: 'https://s.example/m/2',
    },
  ]);
  await withServer({ '/feed.xml': xml(announced) }, async (base) => {
    const r = await readFeed(`${base}/feed.xml`);
    assert.equal(r.overall, STATUS.OPERATIONAL);
  });
});

test('future-dated feed entries are ignored', async () => {
  const body = rssItems([
    {
      title: 'Major outage',
      desc: 'Investigating - everything is down.',
      date: new Date(Date.now() + 3 * 3600 * 1000),
      link: 'https://s.example/i/9',
    },
  ]);
  await withServer({ '/feed.xml': xml(body) }, async (base) => {
    const r = await readFeed(`${base}/feed.xml`);
    assert.equal(r.overall, STATUS.OPERATIONAL);
  });
});

/* ----------------------------- gcp incidents ----------------------------- */

test('gcp reader filters to AI products and grades open incidents', async () => {
  const incidents = [
    {
      external_desc: 'Vertex AI elevated error rates',
      begin: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      status_impact: 'SERVICE_DISRUPTION',
      affected_products: [{ title: 'Vertex AI' }],
      most_recent_update: { when: new Date().toISOString(), text: 'Mitigation underway.' },
      uri: '/incidents/abc',
    },
    {
      external_desc: 'Gemini outage, since resolved',
      begin: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
      end: new Date(Date.now() - 28 * 3600 * 1000).toISOString(),
      status_impact: 'SERVICE_OUTAGE',
      affected_products: [{ title: 'Gemini' }],
    },
    {
      external_desc: 'Cloud SQL is on fire',
      begin: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      status_impact: 'SERVICE_OUTAGE',
      affected_products: [{ title: 'Cloud SQL' }],
    },
  ];
  await withServer({ '/incidents.json': json(incidents) }, async (base) => {
    const r = await readGcp(`${base}/incidents.json`);
    assert.equal(r.ok, true);
    // The unrelated Cloud SQL outage is ignored; the resolved Gemini one too.
    assert.equal(r.overall, STATUS.DEGRADED);
    assert.equal(r.incidents.length, 1);
    assert.match(r.incidents[0].name, /Vertex AI/);
  });
});

test('gcp reader with no open AI incidents is operational', async () => {
  await withServer({ '/incidents.json': json([]) }, async (base) => {
    const r = await readGcp(`${base}/incidents.json`);
    assert.equal(r.overall, STATUS.OPERATIONAL);
  });
});
