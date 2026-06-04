import { and, desc, eq, inArray, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { HttpError } from '../../lib/http-error';
import { invalidatePrincipal } from '../../middleware/auth';
import type { AuthPrincipal } from './auth-service';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResourceBundle {
  fbAccounts: Array<{ id: string; name: string; status: string; adAccountCount: number }>;
  adAccounts: Array<{
    id: string;
    name: string;
    metaActId: string;
    fbAccountId: string;
    status: string;
    currency: string | null;
    timezoneName: string | null;
    businessCountryCode: string | null;
    granted: boolean;
    pending: boolean;
  }>;
}

export interface PermissionApprovalRequestItem {
  id: string;
  requesterId: string;
  requesterEmail: string;
  fbAccountId: string;
  fbAccountName: string;
  requestedAdAccountIds: string[];
  approvedAdAccountIds: string[];
  status: ApprovalStatus;
  note: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewerEmail: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  adAccounts: Array<{
    id: string;
    name: string;
    metaActId: string;
    status: string;
    alreadyGranted: boolean;
  }>;
}

function isBypass(principal: AuthPrincipal): boolean {
  return principal.scope.bypass;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

function toIso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function listMyApprovalResources(
  principal: AuthPrincipal,
): Promise<ApprovalResourceBundle> {
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );

    const fbGrantIds = uniqueIds(principal.scope.fbAccounts);
    if (!isBypass(principal) && fbGrantIds.length === 0) {
      return { fbAccounts: [], adAccounts: [] };
    }

    const fbWhere = isBypass(principal)
      ? eq(schema.fbAccounts.companyId, principal.companyId)
      : and(
          eq(schema.fbAccounts.companyId, principal.companyId),
          inArray(schema.fbAccounts.id, fbGrantIds),
        );

    const fbAccounts = await tx
      .select({
        id: schema.fbAccounts.id,
        name: schema.fbAccounts.name,
        status: schema.fbAccounts.status,
      })
      .from(schema.fbAccounts)
      .where(fbWhere);

    const fbIds = fbAccounts.map((account) => account.id);
    if (fbIds.length === 0) return { fbAccounts: [], adAccounts: [] };

    const [adAccounts, adGrants, pendingRequests] = await Promise.all([
      tx
        .select({
          id: schema.adAccounts.id,
          name: schema.adAccounts.name,
          metaActId: schema.adAccounts.metaActId,
          fbAccountId: schema.adAccounts.fbAccountId,
          status: schema.adAccounts.status,
          currency: schema.adAccounts.currency,
          timezoneName: schema.adAccounts.timezoneName,
          businessCountryCode: schema.adAccounts.businessCountryCode,
        })
        .from(schema.adAccounts)
        .where(
          and(
            eq(schema.adAccounts.companyId, principal.companyId),
            inArray(schema.adAccounts.fbAccountId, fbIds),
          ),
        ),
      tx
        .select({ resourceId: schema.userResourceGrants.resourceId })
        .from(schema.userResourceGrants)
        .where(
          and(
            eq(schema.userResourceGrants.userId, principal.userId),
            eq(schema.userResourceGrants.resourceType, 'ad_account'),
          ),
        ),
      tx
        .select({
          requestedAdAccountIds: schema.permissionApprovalRequests.requestedAdAccountIds,
        })
        .from(schema.permissionApprovalRequests)
        .where(
          and(
            eq(schema.permissionApprovalRequests.companyId, principal.companyId),
            eq(schema.permissionApprovalRequests.requesterId, principal.userId),
            eq(schema.permissionApprovalRequests.status, 'pending'),
          ),
        ),
    ]);

    const grantedIds = new Set(adGrants.map((grant) => grant.resourceId));
    const pendingIds = new Set(pendingRequests.flatMap((request) => request.requestedAdAccountIds));
    const adCountByFb = new Map<string, number>();
    for (const account of adAccounts) {
      adCountByFb.set(account.fbAccountId, (adCountByFb.get(account.fbAccountId) ?? 0) + 1);
    }

    return {
      fbAccounts: fbAccounts.map((account) => ({
        ...account,
        adAccountCount: adCountByFb.get(account.id) ?? 0,
      })),
      adAccounts: adAccounts.map((account) => ({
        ...account,
        granted: grantedIds.has(account.id),
        pending: pendingIds.has(account.id),
      })),
    };
  });
}

export async function createApprovalRequest(
  principal: AuthPrincipal,
  args: { fbAccountId: string; adAccountIds: string[]; note?: string },
): Promise<{ id: string; requestedAdAccountIds: string[] }> {
  const selectedIds = uniqueIds(args.adAccountIds);
  if (selectedIds.length === 0) {
    throw new HttpError(422, 422, '请选择需要申请授权的广告账户');
  }
  if (!isBypass(principal) && !principal.scope.fbAccounts.includes(args.fbAccountId)) {
    throw new HttpError(403, 403, '只能申请已授权 FB 个号下的广告账户');
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );

    const fb = await tx
      .select({ id: schema.fbAccounts.id })
      .from(schema.fbAccounts)
      .where(
        and(
          eq(schema.fbAccounts.id, args.fbAccountId),
          eq(schema.fbAccounts.companyId, principal.companyId),
        ),
      )
      .limit(1);
    if (!fb[0]) throw new HttpError(404, 404, 'FB 个号不存在');

    const adAccounts = await tx
      .select({ id: schema.adAccounts.id })
      .from(schema.adAccounts)
      .where(
        and(
          eq(schema.adAccounts.companyId, principal.companyId),
          eq(schema.adAccounts.fbAccountId, args.fbAccountId),
          inArray(schema.adAccounts.id, selectedIds),
        ),
      );
    if (adAccounts.length !== selectedIds.length) {
      throw new HttpError(422, 422, '存在不属于该 FB 个号的广告账户');
    }

    const existingGrants = await tx
      .select({ resourceId: schema.userResourceGrants.resourceId })
      .from(schema.userResourceGrants)
      .where(
        and(
          eq(schema.userResourceGrants.userId, principal.userId),
          eq(schema.userResourceGrants.resourceType, 'ad_account'),
          inArray(schema.userResourceGrants.resourceId, selectedIds),
        ),
      );
    const grantedIds = new Set(existingGrants.map((grant) => grant.resourceId));

    const pendingRequests = await tx
      .select({ requestedAdAccountIds: schema.permissionApprovalRequests.requestedAdAccountIds })
      .from(schema.permissionApprovalRequests)
      .where(
        and(
          eq(schema.permissionApprovalRequests.companyId, principal.companyId),
          eq(schema.permissionApprovalRequests.requesterId, principal.userId),
          eq(schema.permissionApprovalRequests.fbAccountId, args.fbAccountId),
          eq(schema.permissionApprovalRequests.status, 'pending'),
        ),
      );
    const pendingIds = new Set(pendingRequests.flatMap((request) => request.requestedAdAccountIds));
    const requestIds = selectedIds.filter((id) => !grantedIds.has(id) && !pendingIds.has(id));
    if (requestIds.length === 0) {
      throw new HttpError(409, 409, '所选广告账户已授权或正在审批中');
    }

    const inserted = await tx
      .insert(schema.permissionApprovalRequests)
      .values({
        companyId: principal.companyId,
        requesterId: principal.userId,
        fbAccountId: args.fbAccountId,
        requestedAdAccountIds: requestIds,
        approvedAdAccountIds: [],
        status: 'pending',
        note: args.note?.trim() ? args.note.trim() : null,
      })
      .returning({ id: schema.permissionApprovalRequests.id });
    return { id: inserted[0]!.id, requestedAdAccountIds: requestIds };
  });
  return result;
}

export async function listMyApprovalRequests(
  principal: AuthPrincipal,
): Promise<PermissionApprovalRequestItem[]> {
  return listApprovalRequests(principal, {
    requesterId: principal.userId,
    limit: 100,
  });
}

export async function listApprovalRequests(
  principal: AuthPrincipal,
  args: { status?: ApprovalStatus; requesterId?: string; limit?: number } = {},
): Promise<PermissionApprovalRequestItem[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const conditions = [eq(schema.permissionApprovalRequests.companyId, principal.companyId)];
    if (args.status) conditions.push(eq(schema.permissionApprovalRequests.status, args.status));
    if (args.requesterId) {
      conditions.push(eq(schema.permissionApprovalRequests.requesterId, args.requesterId));
    }

    const rows = await tx
      .select()
      .from(schema.permissionApprovalRequests)
      .where(and(...conditions))
      .orderBy(desc(schema.permissionApprovalRequests.createdAt))
      .limit(args.limit ?? 200);

    return hydrateRequests(tx as unknown as typeof db, rows);
  });
}

export async function reviewApprovalRequest(
  principal: AuthPrincipal,
  requestId: string,
  args: {
    status: 'approved' | 'rejected';
    approvedAdAccountIds?: string[];
    reviewNote?: string;
  },
): Promise<{ id: string; status: ApprovalStatus; approvedAdAccountIds: string[] }> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const request = (
      await tx
        .select()
        .from(schema.permissionApprovalRequests)
        .where(
          and(
            eq(schema.permissionApprovalRequests.id, requestId),
            eq(schema.permissionApprovalRequests.companyId, principal.companyId),
          ),
        )
        .limit(1)
    )[0];
    if (!request) throw new HttpError(404, 404, '审批申请不存在');
    if (request.status !== 'pending') {
      throw new HttpError(409, 409, '该申请已处理，不能重复审批');
    }

    const requestedIds = uniqueIds(request.requestedAdAccountIds);
    let approvedIds: string[] = [];
    if (args.status === 'approved') {
      approvedIds =
        args.approvedAdAccountIds === undefined
          ? requestedIds
          : uniqueIds(args.approvedAdAccountIds);
      if (approvedIds.length === 0) {
        throw new HttpError(422, 422, '请至少勾选一个通过授权的广告账户');
      }
      const requestedSet = new Set(requestedIds);
      if (!approvedIds.every((id) => requestedSet.has(id))) {
        throw new HttpError(422, 422, '通过的广告账户必须来自用户申请列表');
      }
      const adAccounts = await tx
        .select({ id: schema.adAccounts.id })
        .from(schema.adAccounts)
        .where(
          and(
            eq(schema.adAccounts.companyId, principal.companyId),
            eq(schema.adAccounts.fbAccountId, request.fbAccountId),
            inArray(schema.adAccounts.id, approvedIds),
          ),
        );
      if (adAccounts.length !== approvedIds.length) {
        throw new HttpError(422, 422, '存在不属于该 FB 个号的广告账户');
      }
      await tx
        .insert(schema.userResourceGrants)
        .values(
          approvedIds.map((resourceId) => ({
            userId: request.requesterId,
            resourceType: 'ad_account' as const,
            resourceId,
            grantedBy: principal.userId,
          })),
        )
        .onConflictDoNothing();
    }

    await tx
      .update(schema.permissionApprovalRequests)
      .set({
        status: args.status,
        approvedAdAccountIds: approvedIds,
        reviewNote: args.reviewNote?.trim() ? args.reviewNote.trim() : null,
        reviewedBy: principal.userId,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.permissionApprovalRequests.id, request.id));

    return {
      id: request.id,
      requesterId: request.requesterId,
      status: args.status,
      approvedAdAccountIds: approvedIds,
    };
  });
  if (result.status === 'approved') await invalidatePrincipal(result.requesterId);
  return {
    id: result.id,
    status: result.status,
    approvedAdAccountIds: result.approvedAdAccountIds,
  };
}

async function hydrateRequests(
  tx: typeof db,
  rows: Array<typeof schema.permissionApprovalRequests.$inferSelect>,
): Promise<PermissionApprovalRequestItem[]> {
  if (rows.length === 0) return [];
  const requesterIds = uniqueIds(rows.map((row) => row.requesterId));
  const reviewerIds = uniqueIds(rows.map((row) => row.reviewedBy ?? ''));
  const fbIds = uniqueIds(rows.map((row) => row.fbAccountId));
  const adIds = uniqueIds(rows.flatMap((row) => row.requestedAdAccountIds));

  const [requesters, reviewers, fbAccounts, adAccounts, existingGrants] = await Promise.all([
    tx
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, requesterIds)),
    reviewerIds.length > 0
      ? tx
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, reviewerIds))
      : Promise.resolve([]),
    tx
      .select({ id: schema.fbAccounts.id, name: schema.fbAccounts.name })
      .from(schema.fbAccounts)
      .where(inArray(schema.fbAccounts.id, fbIds)),
    adIds.length > 0
      ? tx
          .select({
            id: schema.adAccounts.id,
            name: schema.adAccounts.name,
            metaActId: schema.adAccounts.metaActId,
            status: schema.adAccounts.status,
          })
          .from(schema.adAccounts)
          .where(inArray(schema.adAccounts.id, adIds))
      : Promise.resolve([]),
    adIds.length > 0
      ? tx
          .select({
            userId: schema.userResourceGrants.userId,
            resourceId: schema.userResourceGrants.resourceId,
          })
          .from(schema.userResourceGrants)
          .where(
            and(
              eq(schema.userResourceGrants.resourceType, 'ad_account'),
              inArray(schema.userResourceGrants.resourceId, adIds),
            ),
          )
      : Promise.resolve([]),
  ]);

  const requesterEmailById = new Map(requesters.map((user) => [user.id, user.email]));
  const reviewerEmailById = new Map(reviewers.map((user) => [user.id, user.email]));
  const fbNameById = new Map(fbAccounts.map((account) => [account.id, account.name]));
  const adById = new Map(adAccounts.map((account) => [account.id, account]));
  const grantKeySet = new Set(
    existingGrants.map((grant) => `${grant.userId}:${grant.resourceId}`),
  );

  return rows.map((row) => ({
    id: row.id,
    requesterId: row.requesterId,
    requesterEmail: requesterEmailById.get(row.requesterId) ?? row.requesterId,
    fbAccountId: row.fbAccountId,
    fbAccountName: fbNameById.get(row.fbAccountId) ?? row.fbAccountId,
    requestedAdAccountIds: row.requestedAdAccountIds,
    approvedAdAccountIds: row.approvedAdAccountIds,
    status: row.status,
    note: row.note,
    reviewNote: row.reviewNote,
    reviewedBy: row.reviewedBy,
    reviewerEmail: row.reviewedBy ? (reviewerEmailById.get(row.reviewedBy) ?? row.reviewedBy) : null,
    reviewedAt: toIso(row.reviewedAt),
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
    adAccounts: row.requestedAdAccountIds.map((id) => {
      const account = adById.get(id);
      return {
        id,
        name: account?.name ?? id,
        metaActId: account?.metaActId ?? '-',
        status: account?.status ?? '-',
        alreadyGranted: grantKeySet.has(`${row.requesterId}:${id}`),
      };
    }),
  }));
}
