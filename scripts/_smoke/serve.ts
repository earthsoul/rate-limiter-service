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

const PORT = Number(process.env.PORT ?? 3000);

type Handler = (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => unknown | Promise<unknown>;

const routes: Record<string, Handler> = {
  '/api/check': checkHandler as unknown as Handler,
};

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
  const handler = routes[url.pathname];

  console.log(`${new Date().toISOString()}  ${req.method}  ${url.pathname}`);

  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
    return;
  }

  try {
    const reqWithBody = req as IncomingMessage & { body?: unknown; query?: Record<string, string> };
    reqWithBody.body = await readJsonBody(req);
    reqWithBody.query = Object.fromEntries(url.searchParams);
    decorateResponse(res);
    await handler(reqWithBody, res);
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
