import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const url = process.env['DATABASE_URL'] ?? 'postgres://ads:ads@localhost:5432/ads';

/**
 * 单例 postgres 连接池。注意：RLS 依赖 SET LOCAL app.current_company_id，
 * 因此事务/请求级别的租户上下文必须在拿到连接后注入（见 apps/api/middleware/tenant.ts）。
 */
export const sql = postgres(url, {
  max: 20,
  idle_timeout: 30,
  prepare: false,
});

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export { schema };
