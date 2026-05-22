import type { VercelRequest, VercelResponse } from '@vercel/node';

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
