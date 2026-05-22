import postgres from 'postgres';

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    console.error('POSTGRES_URL is not set. Add it to your .env file and re-run.');
    process.exit(1);
  }

  const sql = postgres(url, { prepare: false });
  try {
    console.log('Running migration: create table rules ...');
    await sql`
      CREATE TABLE IF NOT EXISTS rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        route_pattern TEXT NOT NULL,
        client_key_type TEXT NOT NULL,
        limit_count INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        strategy TEXT NOT NULL DEFAULT 'sliding_window',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules (enabled)`;
    console.log('Migration complete.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
