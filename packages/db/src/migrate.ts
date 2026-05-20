/**
 * 跑迁移 + 应用 RLS。
 *   bun run db:migrate
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url =
  process.env['DATABASE_ADMIN_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://ads:ads@localhost:5432/ads';

async function main() {
  const sql = postgres(url, { max: 1, prepare: false });
  const db = drizzle(sql);

  console.log('[migrate] running drizzle migrations…');
  await migrate(db, { migrationsFolder: join(import.meta.dir, 'migrations') });

  console.log('[migrate] applying RLS policies…');
  const rlsSql = readFileSync(join(import.meta.dir, 'rls.sql'), 'utf-8');
  await sql.unsafe(rlsSql);

  console.log('[migrate] done.');
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
