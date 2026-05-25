/**
 * One-time DB migration. Creates the `rules` table (and its index) if they
 * don't exist yet. Safe to re-run -- both statements use IF NOT EXISTS.
 *
 *   npm run migrate
 *
 * Reads POSTGRES_URL from .env via tsx's --env-file flag.
 *
 * For a real production project you'd use a versioned migrations tool
 * (Flyway, Prisma migrate, etc.) so each schema change becomes its own
 * timestamped file. For a one-table portfolio project this single script
 * is fine -- adds clarity without adding tooling weight.
 */
import postgres from 'postgres';

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.error('POSTGRES_URL is not set. Fill it into .env and re-run.');
    process.exit(1);
  }

  // prepare: false because the Supabase pooler runs in transaction mode
  // and doesn't support prepared statements (would throw 'prepared
  // statement does not exist' on any query that uses them).
  const sql = postgres(url, { prepare: false });

  try {
    console.log('Creating table: rules ...');
    await sql`
      CREATE TABLE IF NOT EXISTS rules (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        route_pattern   TEXT NOT NULL,
        client_key_type TEXT NOT NULL,
        limit_count     INTEGER NOT NULL,
        window_seconds  INTEGER NOT NULL,
        strategy        TEXT NOT NULL DEFAULT 'sliding_window',
        enabled         BOOLEAN NOT NULL DEFAULT true,
        created_at      TIMESTAMPTZ DEFAULT now()
      )
    `;

    console.log('Creating index: idx_rules_enabled on rules(enabled) ...');
    await sql`CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules (enabled)`;

    console.log('Migration complete.');
  } finally {
    // Close the pool cleanly so the process exits instead of hanging.
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
