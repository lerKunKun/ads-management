/**
 * API/Worker 用的 DB 客户端。明确走应用 URL(ads_app 用户, 受 RLS)。
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from '@ads/db';
import { env } from '../env';

export const sql = postgres(env.databaseUrl, {
  max: 20,
  idle_timeout: 30,
  prepare: false,
});

export const db = drizzle(sql, { schema });
export type DB = typeof db;
export { schema };
