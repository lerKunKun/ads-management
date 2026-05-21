/**
 * 单消息处理流程。被 consumer 调用。
 *
 * 步骤:
 *   1. 熔断检查 (fb_account / ad_account)
 *   2. 取操作锁 (targetId)
 *   3. item 状态查重 (idempotency)
 *   4. 令牌桶 acquire (账户+全局)
 *   5. 取并解密 token
 *   6. provider 调 Meta (或 fake)
 *   7. 写 item.success + task counter++ + Redis 进度
 *   错误分类:
 *     - 限流  → adjustHeaders + openBreaker(60s) + retry
 *     - token 失效 → markTokenInvalid + open(fbAccount, ∞) + item failed
 *     - 瞬时 → attempts++ + retry
 *     - 达 max → dead + item.status='dead'
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../api/src/lib/db';
import { decryptToken } from '../../api/src/lib/crypto';
import { redis } from '../../api/src/lib/redis';
import { acquire, DEFAULT_BUCKETS } from '../../api/src/lib/rate-limit';
import { BreakerKey, isOpen, openFor } from '../../api/src/lib/breaker';
import { acquireOpLock } from '../../api/src/lib/op-lock';
import { bumpProgress, setRunning } from '../../api/src/lib/progress';
import { metaProvider } from '../../api/src/providers/meta';
import { meta, MetaApiError, type MetaObjectOwnership } from '../../api/src/lib/meta-client';
import { HttpError } from '../../api/src/lib/http-error';
import {
  markLocalBudget,
  markLocalDeleted,
  markLocalStatus,
  upsertLocalCopyPlaceholder,
} from '../../api/src/modules/ad-object/local-store';
import {
  RMQ,
  publishRetry,
  publishDead,
  type OperationMessage,
} from '../../api/src/lib/rabbitmq-topology';
import { isFake, runFake } from './fake-meta';

export type Outcome =
  | { kind: 'ack' }
  | { kind: 'retry'; reason: string; bumpAttempt?: boolean }
  | { kind: 'dead'; reason: string };

export async function handle(msg: OperationMessage): Promise<Outcome> {
  // 1. 熔断
  const breakers = [
    BreakerKey.fbAccount(msg.fbAccountId),
    BreakerKey.adAccount(msg.metaActId),
  ];
  for (const k of breakers) {
    if (await isOpen(k)) {
      // 软延后,不计入 attempts
      return { kind: 'retry', reason: `breaker open: ${k}`, bumpAttempt: false };
    }
  }

  // 2. 操作锁
  const lock = await acquireOpLock(msg.targetId, 30);
  if (!lock) {
    return { kind: 'retry', reason: 'another op on same target', bumpAttempt: false };
  }

  try {
    // 3. item 查重 (幂等)
    const cur = await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
      const r = await tx
        .select()
        .from(schema.operationTaskItems)
        .where(eq(schema.operationTaskItems.id, msg.itemId))
        .limit(1);
      return r[0];
    });
    if (!cur) return { kind: 'ack' };
    if (cur.status === 'success' || cur.status === 'dead') {
      return { kind: 'ack' };
    }

    // 4. 令牌桶（fake 模式不打真 Meta，跳过）
    if (!isFake()) {
      const rate = await acquire([
        DEFAULT_BUCKETS.app(),
        DEFAULT_BUCKETS.adAccount(msg.metaActId),
      ]);
      if (!rate.allowed) {
        return { kind: 'retry', reason: `rate-limited wait ${rate.waitMs}ms`, bumpAttempt: false };
      }
    }

    // 5. token (fake 模式跳过)
    let token = '';
    if (!isFake()) {
      const cacheKey = `token:${msg.fbAccountId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        token = cached;
      } else {
        const fbRow = await db.transaction(async (tx) => {
          await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
          const r = await tx
            .select({
              enc: schema.fbAccounts.accessTokenEnc,
              status: schema.fbAccounts.status,
            })
            .from(schema.fbAccounts)
            .where(eq(schema.fbAccounts.id, msg.fbAccountId))
            .limit(1);
          return r[0];
        });
        if (!fbRow) {
          await failItem(msg, 'fb_account not found');
          return { kind: 'dead', reason: 'fb_account missing' };
        }
        if (fbRow.status !== 'active') {
          await failItem(msg, `fb_account status ${fbRow.status}`);
          await openFor(BreakerKey.fbAccount(msg.fbAccountId), 0, fbRow.status);
          return { kind: 'dead', reason: `fb_account ${fbRow.status}` };
        }
        token = decryptToken(fbRow.enc);
        await redis.set(cacheKey, token, 'EX', 300);
      }
    }

    // mark running
    await setRunning(msg.taskId);

    // 6. provider 调用
    let result: Record<string, unknown> | undefined;
    try {
      if (isFake()) {
        await runFake(msg.action);
        // fake 模式产出假 result 让前端能看到新 id
        if (msg.action.endsWith(':copy')) {
          const layer = msg.action.split(':')[0];
          result = { newId: `fake_copy_of_${msg.targetId}`, layer };
        }
      } else {
        result = await executeProvider(msg, token);
      }
    } catch (err) {
      return await handleErr(msg, err);
    }

    await writeLocalBestEffort(msg, token, result);

    // 7. 成功
    await markSuccess(msg, result);
    await bumpProgress(msg.taskId, { success: 1 });
    return { kind: 'ack' };
  } finally {
    await lock.release();
  }
}

async function executeProvider(
  msg: OperationMessage,
  token: string,
): Promise<Record<string, unknown> | undefined> {
  const [layer, op] = msg.action.split(':') as [
    'campaign' | 'adset' | 'ad',
    'status' | 'budget' | 'copy' | 'delete',
  ];

  await assertMessageTargetOwnership(msg, token);

  if (op === 'status') {
    const status = msg.params['status'] as 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
    await metaProvider.setStatus(token, {
      adAccountId: msg.metaActId,
      targetId: msg.targetId,
      targetType: layer,
      status,
    });
    return undefined;
  }

  if (op === 'budget') {
    if (layer === 'ad') throw new Error('ad 层无 budget 操作');
    const daily = msg.params['dailyBudget'];
    const life = msg.params['lifetimeBudget'];
    await metaProvider.setBudget(token, {
      adAccountId: msg.metaActId,
      targetId: msg.targetId,
      targetType: layer,
      ...(typeof daily === 'number' ? { dailyBudget: daily } : {}),
      ...(typeof life === 'number' ? { lifetimeBudget: life } : {}),
    });
    return undefined;
  }

  if (op === 'copy') {
    const deepCopy = msg.params['deepCopy'];
    const startTime = msg.params['startTime'];
    const statusOption = msg.params['statusOption'];
    const renameOptionsRaw = msg.params['renameOptions'] as
      | Record<string, string>
      | undefined;
    const copyIndex = msg.params['_copyIndex'];
    // 把 _copyIndex 附加到 rename_suffix(让 N 份命名不冲突)
    let renameOptions = renameOptionsRaw;
    if (typeof copyIndex === 'number' && copyIndex > 0) {
      const baseSuffix = renameOptionsRaw?.['rename_suffix'] ?? '';
      renameOptions = {
        ...(renameOptionsRaw ?? {}),
        rename_suffix: `${baseSuffix}-${String(copyIndex).padStart(2, '0')}`,
      };
    }
    const r = await metaProvider.copy(token, {
      adAccountId: msg.metaActId,
      sourceId: msg.targetId,
      targetType: layer,
      ...(typeof deepCopy === 'boolean' ? { deepCopy } : {}),
      ...(typeof startTime === 'string' ? { startTime } : {}),
      ...(typeof statusOption === 'string'
        ? { statusOption: statusOption as 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE' }
        : {}),
      ...(renameOptions ? { renameOptions } : {}),
    });
    return { newId: r.newId, layer };
  }

  if (op === 'delete') {
    const hard = msg.params['hard'] === true;
    await metaProvider.remove(token, {
      adAccountId: msg.metaActId,
      targetId: msg.targetId,
      targetType: layer,
      hard,
    });
    return undefined;
  }

  throw new Error(`unknown action: ${msg.action}`);
}

async function assertMessageTargetOwnership(
  msg: OperationMessage,
  token: string,
): Promise<MetaObjectOwnership> {
  const owner = await meta.getObjectOwnership(token, msg.targetType, msg.targetId);
  if (owner.actId !== msg.metaActId) {
    throw new HttpError(403, 403, `${msg.targetType} not in ad_account`);
  }
  return owner;
}

async function writeLocalObjectState(
  msg: OperationMessage,
  token: string,
  result?: Record<string, unknown>,
): Promise<void> {
  const [layer, op] = msg.action.split(':') as [
    'campaign' | 'adset' | 'ad',
    'status' | 'budget' | 'copy' | 'delete',
  ];
  const owner = await resolveMessageOwner(msg, token);

  if (op === 'status') {
    const status = msg.params['status'];
    if (
      status === 'ACTIVE' ||
      status === 'PAUSED' ||
      status === 'ARCHIVED' ||
      status === 'DELETED'
    ) {
      await markLocalStatus({
        companyId: msg.companyId,
        adAccountId: msg.adAccountId,
        targetType: layer,
        targetId: msg.targetId,
        status,
        owner,
      });
    }
    return;
  }

  if (op === 'budget') {
    if (layer === 'ad') return;
    const daily = msg.params['dailyBudget'];
    const lifetime = msg.params['lifetimeBudget'];
    await markLocalBudget({
      companyId: msg.companyId,
      adAccountId: msg.adAccountId,
      targetType: layer,
      targetId: msg.targetId,
      ...(typeof daily === 'number' ? { dailyBudget: daily } : {}),
      ...(typeof lifetime === 'number' ? { lifetimeBudget: lifetime } : {}),
      owner,
    });
    return;
  }

  if (op === 'copy') {
    const newId = typeof result?.['newId'] === 'string' ? result['newId'] : undefined;
    if (!newId) return;
    await upsertLocalCopyPlaceholder({
      companyId: msg.companyId,
      adAccountId: msg.adAccountId,
      targetType: layer,
      sourceId: msg.targetId,
      newId,
      owner,
    });
    return;
  }

  if (op === 'delete') {
    await markLocalDeleted({
      companyId: msg.companyId,
      adAccountId: msg.adAccountId,
      targetType: layer,
      targetId: msg.targetId,
      hard: msg.params['hard'] === true,
      owner,
    });
  }
}

async function writeLocalBestEffort(
  msg: OperationMessage,
  token: string,
  result?: Record<string, unknown>,
): Promise<void> {
  try {
    await writeLocalObjectState(msg, token, result);
  } catch (err) {
    console.error(`[local-ad-object] ${msg.action} write failed`, err);
  }
}

async function resolveMessageOwner(
  msg: OperationMessage,
  token: string,
): Promise<MetaObjectOwnership> {
  if (isFake()) return meta.getObjectOwnership('', msg.targetType, msg.targetId);
  return meta.getObjectOwnership(token, msg.targetType, msg.targetId);
}

async function handleErr(msg: OperationMessage, err: unknown): Promise<Outcome> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HttpError && err.status < 500 && err.status !== 429) {
    await failItem(msg, message);
    await bumpProgress(msg.taskId, { failed: 1 });
    return { kind: 'dead', reason: message };
  }
  if (err instanceof MetaApiError) {
    if (err.isTokenInvalid) {
      // 熔断个号
      await db.transaction(async (tx) => {
        await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
        await tx
          .update(schema.fbAccounts)
          .set({ status: 'token_invalid' })
          .where(eq(schema.fbAccounts.id, msg.fbAccountId));
      });
      await redis.del(`token:${msg.fbAccountId}`);
      await openFor(BreakerKey.fbAccount(msg.fbAccountId), 0, 'token_invalid');
      await failItem(msg, `token invalid: ${message}`);
      await bumpProgress(msg.taskId, { failed: 1 });
      return { kind: 'dead', reason: 'token invalid' };
    }
    if (err.isRateLimited) {
      await openFor(BreakerKey.adAccount(msg.metaActId), 60, 'meta rate limited');
      // 限流命中时让该账户挂 60s breaker；本消息走短 retry（attempt 不增）
      return { kind: 'retry', reason: 'meta rate limited', bumpAttempt: false };
    }
  }
  // 瞬时错误 → attempts++
  if (msg.attempt >= RMQ.maxAttempts) {
    await failItem(msg, message);
    await bumpProgress(msg.taskId, { failed: 1 });
    return { kind: 'dead', reason: message };
  }
  await incAttempts(msg);
  return { kind: 'retry', reason: message };
}

async function markSuccess(
  msg: OperationMessage,
  result?: Record<string, unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({
        status: 'success',
        attempts: msg.attempt,
        // MVP: 复用 error 列存 result(JSON);需要 result 的 action(copy) 写,其它清空。
        error: result ? JSON.stringify(result) : null,
      })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
    await tx.execute(
      dsql`UPDATE operation_tasks
           SET success = success + 1,
               status = CASE WHEN success + 1 + failed >= total
                             THEN CASE WHEN failed > 0 THEN 'partial'::operation_status
                                       ELSE 'success'::operation_status END
                             ELSE 'running'::operation_status END
           WHERE id = ${msg.taskId}`,
    );
  });
}

async function failItem(msg: OperationMessage, error: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({
        status: msg.attempt >= RMQ.maxAttempts ? 'dead' : 'failed',
        attempts: msg.attempt,
        error,
      })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
    await tx.execute(
      dsql`UPDATE operation_tasks
           SET failed = failed + 1,
               status = CASE WHEN success + failed + 1 >= total
                             THEN CASE WHEN success > 0 THEN 'partial'::operation_status
                                       ELSE 'failed'::operation_status END
                             ELSE 'running'::operation_status END
           WHERE id = ${msg.taskId}`,
    );
  });
}

async function incAttempts(msg: OperationMessage): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({ status: 'retrying', attempts: msg.attempt })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
  });
}

export { publishRetry, publishDead };
