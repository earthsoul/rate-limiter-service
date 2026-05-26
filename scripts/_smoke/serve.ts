/**
 * Minimal Node HTTP server that wraps our Vercel-style handlers so we can
 * exercise them locally with curl, without needing `vercel dev` or any
 * Vercel CLI auth.
 *
 *   npx tsx --env-file=.env scripts/_smoke/serve.ts
 *
 * Then from another terminal:
 *   curl -i -X POST http://localhost:3000/api/check \
 *        -H "Content-Type: application/json" \
 *        -d '{"route":"/api/test","clientKey":"ip:1.2.3.4"}'
 *
 * Maps URL paths to our handlers and shims the few VercelResponse helpers
 * (`status()`, `json()`) our handlers depend on.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import checkHandler from '../../api/check.js';
import mockHandler from '../../api/mock/[...path].js';
import rulesIdHandler from '../../api/rules/[id].js';
import rulesIndexHandler from '../../api/rules/index.js';
import statsHandler from '../../api/stats/[clientKey].js';

const PORT = Number(process.env.PORT ?? 3000);

type ExtendedRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[]>;
};
type Handler = (req: ExtendedRequest, res: ServerResponse) => unknown | Promise<unknown>;

// Resolve a URL pathname to a handler + any captured route params.
// Mimics Vercel's file-system routing for the routes we care about.
function resolveRoute(pathname: string):
  | { handler: Handler; params: Record<string, string | string[]> }
  | null {
  if (pathname === '/api/check') {
    return { handler: checkHandler as unknown as Handler, params: {} };
  }
  // /api/rules -- list + create
  if (pathname === '/api/rules') {
    return { handler: rulesIndexHandler as unknown as Handler, params: {} };
  }
  // /api/rules/[id] -- single-segment dynamic param
  const rulesIdMatch = pathname.match(/^\/api\/rules\/([^/]+)$/);
  if (rulesIdMatch) {
    return {
      handler: rulesIdHandler as unknown as Handler,
      params: { id: rulesIdMatch[1]! },
    };
  }
  // /api/stats/[clientKey] -- clientKey may contain colons (ip:1.2.3.4), no slashes
  const statsMatch = pathname.match(/^\/api\/stats\/([^/]+)$/);
  if (statsMatch) {
    return {
      handler: statsHandler as unknown as Handler,
      params: { clientKey: decodeURIComponent(statsMatch[1]!) },
    };
  }
  // /api/mock/[...path] -- catch-all, captures rest of URL as an array
  if (pathname === '/api/mock' || pathname.startsWith('/api/mock/')) {
    const rest = pathname.replace(/^\/api\/mock\/?/, '');
    return {
      handler: mockHandler as unknown as Handler,
      params: { path: rest ? rest.split('/') : [] },
    };
  }
  return null;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Add the chainable helpers (.status(N).json(...)) our handlers expect from VercelResponse.
function decorateResponse(res: ServerResponse) {
  const r = res as ServerResponse & {
    status: (code: number) => typeof r;
    json: (body: unknown) => typeof r;
  };
  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };
  r.json = (body: unknown) => {
    if (!r.getHeader('Content-Type')) r.setHeader('Content-Type', 'application/json');
    r.end(JSON.stringify(body));
    return r;
  };
  return r;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const resolved = resolveRoute(url.pathname);

  console.log(`${new Date().toISOString()}  ${req.method}  ${url.pathname}`);

  if (!resolved) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
    return;
  }

  try {
    const reqWithBody = req as ExtendedRequest;
    reqWithBody.body = await readJsonBody(req);
    // Merge query string params with the captured route params (e.g. `path` from a catch-all).
    reqWithBody.query = { ...Object.fromEntries(url.searchParams), ...resolved.params };
    decorateResponse(res);
    await resolved.handler(reqWithBody, res);
  } catch (err) {
    console.error('handler error', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`Local smoke server listening on http://localhost:${PORT}`);
  console.log(`Try:  curl -i -X POST http://localhost:${PORT}/api/check -H "Content-Type: application/json" -d '{"route":"/api/test","clientKey":"ip:1.2.3.4"}'`);
});
