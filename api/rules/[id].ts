import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deleteRule, getRule } from '../../lib/db.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { id } = req.query;
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    if (req.method === 'GET') {
      const rule = await getRule(id);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      return res.status(200).json(rule);
    }

    if (req.method === 'DELETE') {
      const ok = await deleteRule(id);
      if (!ok) return res.status(404).json({ error: 'Rule not found' });
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('rules/[id] handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
