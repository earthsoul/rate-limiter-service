import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deleteRule, getRule } from '../../lib/db.js';

// 8-4-4-4-12 hex. Doesn't care about UUID version -- gen_random_uuid() is v4
// but we accept any value that matches the shape. The point isn't to parse the
// UUID for meaning -- it's to reject obvious garbage before we hit Postgres.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Vercel captures the [id] segment into req.query.id (always a string for
  // single-segment dynamic params; arrays only happen for catch-alls like
  // [...path].ts).
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    // 400, not 500: malformed input is the *client's* problem. Catching here
    // also short-circuits the DB roundtrip for obviously bad requests, and
    // avoids surfacing Postgres's 22P02 error as an opaque 500.
    return res.status(400).json({ error: 'invalid_id', message: 'id must be a UUID' });
  }

  if (req.method === 'GET') {
    try {
      const rule = await getRule(id);
      // null from the DB layer -> 404 here. No try/catch needed for the
      // "not found" case because getRule treats it as a normal return value.
      if (!rule) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({ rule });
    } catch (err) {
      console.error('GET /api/rules/[id] failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const deleted = await deleteRule(id);
      // false means "no row matched" -- treat the same as GET-not-found.
      if (!deleted) return res.status(404).json({ error: 'not_found' });
      // 204 No Content is the idiomatic REST response for a successful
      // delete: "did what you asked, nothing meaningful to put in the body".
      return res.status(204).end();
    } catch (err) {
      console.error('DELETE /api/rules/[id] failed', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  res.setHeader('Allow', 'GET, DELETE, OPTIONS');
  return res.status(405).json({ error: 'method_not_allowed' });
}
