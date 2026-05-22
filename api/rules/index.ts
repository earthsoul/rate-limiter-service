import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createRule, listRules } from '../../lib/db.js';
import type { ClientKeyType, CreateRuleInput, Strategy } from '../../lib/types.js';

const ALLOWED_KEY_TYPES: ClientKeyType[] = ['ip', 'api_key', 'user_id'];
const ALLOWED_STRATEGIES: Strategy[] = ['sliding_window', 'fixed_window'];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const rules = await listRules();
      return res.status(200).json(rules);
    }

    if (req.method === 'POST') {
      const body = req.body as Partial<CreateRuleInput> | undefined;
      if (!body) return res.status(400).json({ error: 'Missing request body' });
      const errors = validateCreateRule(body);
      if (errors.length) {
        return res.status(400).json({ error: 'Validation failed', details: errors });
      }
      const created = await createRule(body as CreateRuleInput);
      return res.status(201).json(created);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('rules handler error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function validateCreateRule(input: Partial<CreateRuleInput>): string[] {
  const errors: string[] = [];
  if (!input.routePattern || typeof input.routePattern !== 'string') {
    errors.push('routePattern is required and must be a string');
  }
  if (!input.clientKeyType || !ALLOWED_KEY_TYPES.includes(input.clientKeyType)) {
    errors.push(`clientKeyType must be one of: ${ALLOWED_KEY_TYPES.join(', ')}`);
  }
  if (typeof input.limitCount !== 'number' || !Number.isInteger(input.limitCount) || input.limitCount <= 0) {
    errors.push('limitCount must be a positive integer');
  }
  if (
    typeof input.windowSeconds !== 'number' ||
    !Number.isInteger(input.windowSeconds) ||
    input.windowSeconds <= 0
  ) {
    errors.push('windowSeconds must be a positive integer');
  }
  if (input.strategy && !ALLOWED_STRATEGIES.includes(input.strategy)) {
    errors.push(`strategy must be one of: ${ALLOWED_STRATEGIES.join(', ')}`);
  }
  return errors;
}
