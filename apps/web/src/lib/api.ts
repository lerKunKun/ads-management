/**
 * 简单 fetch 客户端。Eden 在 packages/eden 已经提供类型，但为了让 web 启动更轻，
 * 这里 M1 用 fetch + 手写少量 hook；M2 再换 Eden（已经有现成 client）。
 */
const TOKEN_KEY = 'ads:token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: number,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set('content-type', 'application/json');
  const tok = getToken();
  if (tok) headers.set('authorization', `Bearer ${tok}`);
  const res = await fetch(`/api${path}`, { ...init, headers });
  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError(`HTTP ${res.status}`, res.status, res.status);
  }
  if (res.status === 401) {
    clearToken();
    throw new ApiError(body.msg ?? 'unauthorized', res.status, body.code, body.requestId);
  }
  if (body.code !== 0) {
    throw new ApiError(body.msg ?? `code=${body.code}`, res.status, body.code, body.requestId);
  }
  return body.data;
}

export interface Me {
  id: string;
  email: string;
  companyId: string;
  companyName: string;
  roles: string[];
  permissions: string[];
  scope: { fbAccounts: string[]; adAccounts: string[]; bypass: boolean };
}

export interface Company {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  createdAt: string;
  userCount: number;
  accountGroupCount: number;
  adAccountCount: number;
}

export interface CompanyUser {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  createdAt: string;
  roles: string[];
  grantsCount: number;
}

export interface FbAccount {
  id: string;
  fbUserId: string;
  name: string;
  status: 'active' | 'token_invalid' | 'disabled';
  tokenExpiresAt: string | null;
  adAccountCount: number;
}

export interface AdAccount {
  id: string;
  metaActId: string;
  name: string;
  currency: string | null;
  timezoneName: string | null;
  businessCountryCode: string | null;
  status: 'active' | 'disabled' | 'closed' | 'pending';
  lastSyncedAt: string | null;
  fbAccountId: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface AdAccountFacets {
  currencies: string[];
  timezoneNames: string[];
  businessCountryCodes: string[];
}

export interface AdSet {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
  effectiveStatus?: string;
  campaignId?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  optimizationGoal?: string;
  startTime?: string;
  endTime?: string;
  updatedTime?: string;
}

export interface Ad {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
  effectiveStatus?: string;
  adsetId?: string;
  campaignId?: string;
  creativeId?: string;
  adsetStartTime?: string;
  adsetEndTime?: string;
  updatedTime?: string;
}

export interface InsightsSummary {
  spend: number;
  impressions: number;
  clicks: number;
  cpc: number;
  cpm: number;
  ctr: number;
  orders: number;
  cpa: number;
  addToCart: number;
  initiateCheckout: number;
}

export type DatePreset =
  | 'today'
  | 'yesterday'
  | 'last_7d'
  | 'last_30d'
  | 'maximum';

export interface RenameOptions {
  rename_strategy?: 'DEEP_COPY_RENAME' | 'NO_RENAME' | 'ONLY_TOP_LEVEL_RENAME';
  rename_prefix?: string;
  rename_suffix?: string;
}

export interface CopyParams {
  count?: number;
  deepCopy?: boolean;
  startTime?: string;
  endTime?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  statusOption?: 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE';
  renameOptions?: RenameOptions;
}

export interface AdAccountSummary {
  id: string;
  metaActId: string;
  name: string;
  currency: string | null;
  timezoneName: string | null;
  businessCountryCode: string | null;
  status: string;
  fbAccountId: string;
  fbAccountName: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
  effectiveStatus?: string;
  objective?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  startTime?: string;
  stopTime?: string;
  updatedTime?: string;
}

export interface TaskLayerProgress {
  targetType: 'campaign' | 'adset' | 'ad';
  label: string;
  total: number;
  success: number;
  failed: number;
  running: number;
  pending: number;
  successItems: TaskLayerProgressItem[];
  failedItems: TaskLayerProgressItem[];
}

export interface TaskLayerProgressItem {
  id: string;
  targetId: string;
  status: string;
  attempts: number;
  detail: string | null;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'partial'
  | 'success'
  | 'failed'
  | 'cancelled';

export const api = {
  login: (email: string, password: string) =>
    call<{ token: string; user: Omit<Me, 'scope'> }>('/iam/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => call<Me>('/iam/me'),
  changeOwnPassword: (args: { currentPassword: string; newPassword: string }) =>
    call<null>('/iam/me/password', {
      method: 'POST',
      body: JSON.stringify(args),
    }),
  switchCompany: (companyId: string) =>
    call<{ token: string; user: Omit<Me, 'scope'> }>('/iam/switch-company', {
      method: 'POST',
      body: JSON.stringify({ companyId }),
    }),
  fbAccounts: () => call<FbAccount[]>('/fb-accounts'),
  adAccounts: (fbAccountId?: string) =>
    call<AdAccount[]>(
      `/ad-accounts${fbAccountId ? `?fb_account_id=${encodeURIComponent(fbAccountId)}` : ''}`,
    ),
  adAccountsPage: (opts: {
    page: number;
    pageSize: number;
    fbAccountId?: string;
    search?: string;
    status?: string;
    currency?: string;
    timezoneName?: string;
    businessCountryCode?: string;
  }) => {
    const qp = new URLSearchParams();
    qp.set('paged', '1');
    qp.set('page', String(opts.page));
    qp.set('page_size', String(opts.pageSize));
    if (opts.fbAccountId) qp.set('fb_account_id', opts.fbAccountId);
    if (opts.search) qp.set('search', opts.search);
    if (opts.status) qp.set('status', opts.status);
    if (opts.currency) qp.set('currency', opts.currency);
    if (opts.timezoneName) qp.set('timezone_name', opts.timezoneName);
    if (opts.businessCountryCode) qp.set('business_country_code', opts.businessCountryCode);
    return call<PageResult<AdAccount> & { facets: AdAccountFacets }>(`/ad-accounts?${qp.toString()}`);
  },
  fbAuthorizeUrl: () =>
    call<{ authorize_url: string }>('/oauth/fb/authorize-url', { method: 'POST' }),
  fbCallback: (code: string) =>
    call<{ fbAccountId: string; adAccountsSynced: number }>('/oauth/fb/callback', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  // M2: 广告账户详情 / campaign 操作
  adAccountSummary: (id: string) => call<AdAccountSummary>(`/ad-accounts/${id}/summary`),
  campaigns: (id: string) => call<Campaign[]>(`/ad-accounts/${id}/campaigns`),
  setCampaignStatus: (
    campaignId: string,
    adAccountId: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ) =>
    call<null>(`/campaigns/${campaignId}/status`, {
      method: 'POST',
      body: JSON.stringify({ adAccountId, status }),
    }),
  setCampaignBudget: (
    campaignId: string,
    adAccountId: string,
    budget: { dailyBudget?: number; lifetimeBudget?: number },
  ) =>
    call<null>(`/campaigns/${campaignId}/budget`, {
      method: 'POST',
      body: JSON.stringify({ adAccountId, ...budget }),
    }),

  // M4 三层 status / budget / copy / delete
  setStatus: (
    layer: 'campaign' | 'adset' | 'ad',
    id: string,
    adAccountId: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ) =>
    call<null>(`/${layer}s/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ adAccountId, status }),
    }),
  setBudget: (
    layer: 'campaign' | 'adset',
    id: string,
    adAccountId: string,
    budget: { dailyBudget?: number; lifetimeBudget?: number },
  ) =>
    call<null>(`/${layer}s/${id}/budget`, {
      method: 'POST',
      body: JSON.stringify({ adAccountId, ...budget }),
    }),
  copyEntity: (
    layer: 'campaign' | 'adset' | 'ad',
    id: string,
    adAccountId: string,
    opts: CopyParams,
  ) =>
    call<{ newIds: string[] }>(`/${layer}s/${id}/copy`, {
      method: 'POST',
      body: JSON.stringify({ adAccountId, ...opts }),
    }),
  deleteEntity: (
    layer: 'campaign' | 'adset' | 'ad',
    id: string,
    adAccountId: string,
    hard = false,
  ) =>
    call<null>(`/${layer}s/${id}/delete`, {
      method: 'POST',
      body: JSON.stringify({ adAccountId, hard }),
    }),

  // 三层 list + insights
  adSets: (adAccountId: string, campaignId: string) =>
    call<AdSet[]>(`/ad-accounts/${adAccountId}/campaigns/${campaignId}/adsets`),
  ads: (adAccountId: string, adsetId: string) =>
    call<Ad[]>(`/ad-accounts/${adAccountId}/adsets/${adsetId}/ads`),
  insightsByLevel: (
    adAccountId: string,
    level: 'campaign' | 'adset' | 'ad',
    preset: DatePreset,
  ) =>
    call<Record<string, InsightsSummary>>(
      `/ad-accounts/${adAccountId}/insights?level=${level}&preset=${preset}`,
    ),

  // M3: 批量入队 + 任务查询
  batchOperations: (req: {
    action:
      | 'campaign:status'
      | 'campaign:budget'
      | 'campaign:copy'
      | 'campaign:delete'
      | 'adset:status'
      | 'adset:budget'
      | 'adset:copy'
      | 'adset:delete'
      | 'ad:status'
      | 'ad:copy'
      | 'ad:delete';
    params: Record<string, unknown>;
    targets: Array<{
      ad_account_id: string;
      target_type: 'campaign' | 'adset' | 'ad';
      target_id: string;
      params?: Record<string, unknown>;
    }>;
  }) =>
    call<{ taskId: string; total: number }>('/operations/batch', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  // IAM: 用户与作用域管理 (权限 iam:manage)
  listUsers: () =>
    call<
      Array<{
        id: string;
        email: string;
        status: 'active' | 'disabled';
        createdAt: string;
        roles: string[];
        grantsCount: number;
        fbAccountGrantCount: number;
        adAccountGrantCount: number;
      }>
    >('/iam/users'),
  createUser: (email: string, password: string, roleCode: string) =>
    call<{ id: string }>('/iam/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, roleCode }),
    }),
  updateUser: (
    id: string,
    patch: { roleCode?: string; status?: 'active' | 'disabled' },
  ) =>
    call<null>(`/iam/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteUser: (id: string) =>
    call<{
      id: string;
      email: string;
      auditLogsDetached: number;
      tasksReassigned: number;
      grantsReassigned: number;
    }>(`/iam/users/${id}`, { method: 'DELETE' }),
  listRoles: () =>
    call<Array<{ id: string; code: string; name: string; scope: 'platform' | 'company' }>>(
      '/iam/roles',
    ),
  listGrants: (userId: string) =>
    call<
      Array<{ id: string; resourceType: 'fb_account' | 'ad_account'; resourceId: string }>
    >(`/iam/users/${userId}/grants`),
  addGrant: (
    userId: string,
    resourceType: 'fb_account' | 'ad_account',
    resourceId: string,
  ) =>
    call<{ id: string }>(`/iam/users/${userId}/grants`, {
      method: 'POST',
      body: JSON.stringify({ resourceType, resourceId }),
    }),
  removeGrant: (userId: string, grantId: string) =>
    call<null>(`/iam/users/${userId}/grants/${grantId}`, { method: 'DELETE' }),
  listGrantResources: () =>
    call<{
      fbAccounts: Array<{ id: string; name: string; status: string }>;
      adAccounts: Array<{
        id: string;
        name: string;
        metaActId: string;
        fbAccountId: string;
        status: string;
        currency: string | null;
        timezoneName: string | null;
        businessCountryCode: string | null;
      }>;
    }>('/iam/grant-resources'),

  // M4: 管理端点 (权限 iam:manage)
  listCompanies: () => call<Company[]>('/_admin/companies'),
  createCompany: (name: string) =>
    call<{ id: string }>('/_admin/companies', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateCompany: (id: string, patch: { name?: string; status?: 'active' | 'disabled' }) =>
    call<null>(`/_admin/companies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  listCompanyUsers: (companyId: string) =>
    call<CompanyUser[]>(`/_admin/companies/${companyId}/users`),
  createCompanyUser: (
    companyId: string,
    args: { email: string; password: string; roleCode: string },
  ) =>
    call<{ id: string }>(`/_admin/companies/${companyId}/users`, {
      method: 'POST',
      body: JSON.stringify(args),
    }),
  updateCompanyUser: (
    companyId: string,
    userId: string,
    patch: { roleCode?: string; status?: 'active' | 'disabled' },
  ) =>
    call<null>(`/_admin/companies/${companyId}/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteCompanyUser: (companyId: string, userId: string) =>
    call<{
      id: string;
      email: string;
      auditLogsDetached: number;
      tasksReassigned: number;
      grantsReassigned: number;
    }>(`/_admin/companies/${companyId}/users/${userId}`, { method: 'DELETE' }),
  listBreakers: () =>
    call<
      Array<{ key: string; kind: 'adacct' | 'fb'; target: string; reason: string; ttl: number }>
    >('/_admin/breakers'),
  resetBreakers: (keys: string[]) =>
    call<{ reset: number }>('/_admin/breakers/reset', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    }),
  scanTokenHealth: () =>
    call<{ scanned: number; notified: number }>('/_admin/scan-token-health', { method: 'POST' }),
  syncAdObjects: (args: {
    adAccountId?: string;
    depth?: 'campaign' | 'adset' | 'ad';
    limit?: number;
  } = {}) =>
    call<
      | {
          adAccountId: string;
          metaActId: string;
          campaigns: number;
          adsets: number;
          ads: number;
          depth: 'campaign' | 'adset' | 'ad';
        }
      | {
          candidates: number;
          synced: number;
          failed: number;
          skipped: number;
          results: Array<{
            adAccountId: string;
            metaActId: string;
            campaigns: number;
            adsets: number;
            ads: number;
            depth: 'campaign' | 'adset' | 'ad';
          }>;
        }
    >('/_admin/sync-ad-objects', {
      method: 'POST',
      body: JSON.stringify(args),
    }),
  listTasks: (limit = 50) =>
    call<
      Array<{
        id: string;
        type: string;
        status: string;
        total: number;
        success: number;
        failed: number;
        userId: string;
        createdAt: string;
        updatedAt: number | null;
        payload: unknown;
      }>
    >(`/_admin/tasks?limit=${limit}`),
  listAudit: (opts: { limit?: number; action?: string } = {}) => {
    const qp = new URLSearchParams();
    if (opts.limit) qp.set('limit', String(opts.limit));
    if (opts.action) qp.set('action', opts.action);
    return call<
      Array<{
        id: string;
        action: string;
        resource: string;
        detail: unknown;
        ip: string | null;
        userId: string | null;
        createdAt: string;
      }>
    >(`/_admin/audit?${qp.toString()}`);
  },

  taskStatus: (taskId: string) =>
    call<{
      taskId: string;
      total: number;
      success: number;
      failed: number;
      status: TaskStatus;
      updatedAt: number;
      type: string;
      payload: unknown;
      createdAt: string;
      userId: string;
      layerProgress: TaskLayerProgress[];
      failures: Array<{ id: string; targetId: string; error: string | null; attempts: number }>;
    }>(`/operations/${taskId}`),
  taskItems: (
    taskId: string,
    opts: {
      targetType: 'campaign' | 'adset' | 'ad';
      status: 'success' | 'failed';
      page: number;
      pageSize: number;
    },
  ) => {
    const qp = new URLSearchParams();
    qp.set('target_type', opts.targetType);
    qp.set('status', opts.status);
    qp.set('page', String(opts.page));
    qp.set('page_size', String(opts.pageSize));
    return call<PageResult<TaskLayerProgressItem>>(`/operations/${taskId}/items?${qp.toString()}`);
  },
  pauseTask: (taskId: string) =>
    call<null>(`/operations/${taskId}/pause`, { method: 'POST' }),
  resumeTask: (taskId: string) =>
    call<null>(`/operations/${taskId}/resume`, { method: 'POST' }),
  stopTask: (taskId: string) =>
    call<null>(`/operations/${taskId}/stop`, { method: 'POST' }),
};

/** SSE: 返回 EventSource，调用方负责 close。token 通过 query 传(浏览器 EventSource 不支持自定义 header) */
export function openTaskStream(taskId: string): EventSource {
  const tok = getToken();
  // 简化：M3 用 cookie/query 模式都行；这里直接在 URL 上挂 token,
  // 上线前要么走同源 cookie，要么把 SSE 端点改为支持 ?token=
  // 为兼容现在的 authGuard(只读 header),先在 vite proxy 阶段允许 ?token=
  const url = `/api/operations/${encodeURIComponent(taskId)}/stream${tok ? `?token=${encodeURIComponent(tok)}` : ''}`;
  return new EventSource(url);
}
