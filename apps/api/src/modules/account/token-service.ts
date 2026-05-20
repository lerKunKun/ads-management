/**
 * 拿 fb_account 的解密 token（带 Redis 缓存 + token 失效熔断）。
 * 调用方: operation 模块在执行 Meta 写操作前调用。
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { decryptToken } from '../../lib/crypto';
import { redis } from '../../lib/redis';
import { notifier } from '../../lib/notifier';
import { HttpError } from '../../lib/http-error';
import { FAKE_MODE } from '../../lib/fake-meta-state';

const TOKEN_TTL = 300; // 5 min

export interface FbAccountTokenCtx {
  fbAccountId: string;
  metaActId: string;
  /** 广告账户行 id（业务主键，不是 act_xxx） */
  adAccountId: string;
}

/**
 * 通过 ad_account 业务 id 反查 fb_account_id + meta_act_id + 解密 token。
 * 调用前必须已 SET LOCAL app.current_company_id（事务内）。
 */
export async function resolveAdAccount(
  companyId: string,
  adAccountId: string,
): Promise<FbAccountTokenCtx & { token: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    const rows = await tx
      .select({
        adId: schema.adAccounts.id,
        metaActId: schema.adAccounts.metaActId,
        fbAccountId: schema.adAccounts.fbAccountId,
        fbStatus: schema.fbAccounts.status,
        accessTokenEnc: schema.fbAccounts.accessTokenEnc,
      })
      .from(schema.adAccounts)
      .innerJoin(schema.fbAccounts, eq(schema.fbAccounts.id, schema.adAccounts.fbAccountId))
      .where(
        and(
          eq(schema.adAccounts.id, adAccountId),
          eq(schema.adAccounts.companyId, companyId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new HttpError(404, 404, 'ad_account not found in current company');
    }
    if (row.fbStatus === 'token_invalid') {
      throw new HttpError(409, 1003, 'fb_account token invalid; please rebind');
    }
    if (row.fbStatus === 'disabled') {
      throw new HttpError(409, 1003, 'fb_account disabled');
    }

    // Redis 缓存优先
    const cacheKey = `token:${row.fbAccountId}`;
    let token = await redis.get(cacheKey);
    if (!token) {
      // FAKE_MODE 下 access_token_enc 是 mock 字符串,跳过解密
      token = FAKE_MODE ? 'FAKE-TOKEN' : decryptToken(row.accessTokenEnc);
      await redis.set(cacheKey, token, 'EX', TOKEN_TTL);
    }
    return {
      token,
      fbAccountId: row.fbAccountId,
      metaActId: row.metaActId,
      adAccountId: row.adId,
    };
  });
}

/** Meta token 失效（190/OAuthException）时:标记个号 + 删缓存 + 告警 */
export async function markTokenInvalid(
  companyId: string,
  fbAccountId: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    await tx
      .update(schema.fbAccounts)
      .set({ status: 'token_invalid' })
      .where(eq(schema.fbAccounts.id, fbAccountId));
  });
  await redis.del(`token:${fbAccountId}`);
  await notifier.notify('error', 'FB token 失效，已熔断', {
    companyId,
    fbAccountId,
    reason,
  });
}
