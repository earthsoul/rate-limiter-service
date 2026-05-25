import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Mock upstream endpoint -- echoes whatever you send.
 *
 * The `[...path]` filename is Vercel's catch-all syntax: this single
 * handler responds to /api/mock, /api/mock/users, /api/mock/users/42, etc.
 * The captured segments arrive as req.query.path: string[].
 *
 * Exists so the README can demo "rate limiter sitting in front of a real
 * API" without us having to build a real API.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { path } = req.query;
  const pathStr = Array.isArray(path) ? path.join('/') : path ?? '';

  return res.status(200).json({
    message: 'Mock upstream response',
    path: `/api/mock/${pathStr}`,
    method: req.method,
    timestamp: new Date().toISOString(),
    headers: req.headers,
    query: req.query,
    body: req.body ?? null,
  });
}
