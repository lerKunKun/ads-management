/**
 * mock seed: 一个 fb_account + N 个 ad_account 用于 M3 集成冒烟(META_FAKE=1)。
 *   bun run src/seed-mock-fb.ts
 * 输出: ad_account.id 列表(stdout 一行一个),给批量入队脚本消费。
 */
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { companies, fbAccounts, adAccounts } from './schema';

const url =
  process.env['DATABASE_ADMIN_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://ads:ads@localhost:5432/ads';

const AD_ACCOUNT_COUNT = Number(process.env['MOCK_AD_ACCOUNT_COUNT'] ?? '10');
const MOCK_ACCOUNT_PROFILES = [
  { currency: 'USD', timezoneName: 'America/Los_Angeles', businessCountryCode: 'US' },
  { currency: 'GBP', timezoneName: 'Europe/London', businessCountryCode: 'GB' },
  { currency: 'EUR', timezoneName: 'Europe/Berlin', businessCountryCode: 'DE' },
  { currency: 'JPY', timezoneName: 'Asia/Tokyo', businessCountryCode: 'JP' },
  { currency: 'SGD', timezoneName: 'Asia/Singapore', businessCountryCode: 'SG' },
  { currency: 'AUD', timezoneName: 'Australia/Sydney', businessCountryCode: 'AU' },
];

async function main() {
  const sql = postgres(url, { max: 1, prepare: false });
  const db = drizzle(sql);
  await sql`SET app.bypass_rls = '1'`;

  const companyName = process.env['MOCK_COMPANY_NAME'];
  const company = companyName
    ? (await db.select().from(companies).where(eq(companies.name, companyName)).limit(1))[0]
    : (
        await db
          .select()
          .from(companies)
          .where(eq(companies.status, 'active'))
          .orderBy(asc(companies.createdAt))
          .limit(1)
      )[0];
  if (!company) throw new Error('active company not found; run seed first');

  // fb_account: mock token enc (fake mode 跳过解密)
  const FB_USER_ID = 'mock_fb_user_1';
  let fb = (
    await db
      .select()
      .from(fbAccounts)
      .where(
        and(eq(fbAccounts.companyId, company.id), eq(fbAccounts.fbUserId, FB_USER_ID)),
      )
      .limit(1)
  )[0];
  if (!fb) {
    fb = (
      await db
        .insert(fbAccounts)
        .values({
          companyId: company.id,
          fbUserId: FB_USER_ID,
          name: 'Mock FB Account',
          accessTokenEnc: 'MOCK-NOT-A-REAL-TOKEN',
          tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
          status: 'active',
        })
        .returning()
    )[0]!;
  } else {
    await db
      .update(fbAccounts)
      .set({ status: 'active' })
      .where(eq(fbAccounts.id, fb.id));
  }

  // N 个 ad_account
  const ids: string[] = [];
  for (let i = 0; i < AD_ACCOUNT_COUNT; i++) {
    const actId = `act_mock_${i}`;
    const profile = MOCK_ACCOUNT_PROFILES[i % MOCK_ACCOUNT_PROFILES.length]!;
    const existed = (
      await db
        .select()
        .from(adAccounts)
        .where(
          and(eq(adAccounts.companyId, company.id), eq(adAccounts.metaActId, actId)),
        )
        .limit(1)
    )[0];
    if (existed) {
      await db
        .update(adAccounts)
        .set({
          currency: profile.currency,
          timezoneName: profile.timezoneName,
          businessCountryCode: profile.businessCountryCode,
          status: 'active',
          lastSyncedAt: new Date(),
        })
        .where(eq(adAccounts.id, existed.id));
      ids.push(existed.id);
      continue;
    }
    const ins = await db
      .insert(adAccounts)
      .values({
        fbAccountId: fb.id,
        companyId: company.id,
        metaActId: actId,
        name: `Mock Ad Account ${i}`,
        currency: profile.currency,
        timezoneName: profile.timezoneName,
        businessCountryCode: profile.businessCountryCode,
        status: 'active',
        lastSyncedAt: new Date(),
      })
      .returning({ id: adAccounts.id });
    ids.push(ins[0]!.id);
  }
  console.error(`[seed-mock-fb] company=${company.id} fb=${fb.id} ad_accounts=${ids.length}`);
  // 一行一个,便于 shell 消费
  for (const id of ids) console.log(id);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
