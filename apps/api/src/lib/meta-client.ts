/**
 * Meta Graph API 客户端（v21.0，CRM 端锁定的版本）。
 * 覆盖 campaign / adset / ad 三层 + insights。
 * 真实模式直连 https://graph.facebook.com/{ver}/...; FAKE_MODE 走 fake-meta-state 内存 mock。
 */
import { env } from '../env';
import { FAKE_MODE, fakeMeta } from './fake-meta-state';

// ===== 通用 =====
interface MetaPagedEnvelope<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

interface MetaErrorEnvelope {
  error: {
    message: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_user_msg?: string;
    error_user_title?: string;
  };
}

export class MetaApiError extends Error {
  constructor(
    public httpStatus: number,
    public metaCode: number | undefined,
    public metaSubcode: number | undefined,
    public metaType: string | undefined,
    public traceId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
  get isTokenInvalid(): boolean {
    return this.metaCode === 190;
  }
  get isRateLimited(): boolean {
    return (
      this.metaCode === 17 ||
      this.metaCode === 4 ||
      this.metaCode === 32 ||
      this.metaCode === 80004
    );
  }
}

// ===== Ad Account =====
interface MetaAdAccount {
  id: string;
  account_id?: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  business_country_code?: string;
  account_status?: number;
}

const ACCT_STATUS_MAP: Record<number, 'active' | 'disabled' | 'closed' | 'pending'> = {
  1: 'active',
  2: 'disabled',
  3: 'disabled',
  7: 'pending',
  9: 'disabled',
  101: 'closed',
};

// ===== Campaign / AdSet / Ad =====
export type EntityStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';

interface MetaCampaignRaw {
  id: string;
  name?: string;
  status?: EntityStatus;
  effective_status?: string;
  objective?: string;
  buying_type?: string;
  bid_strategy?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  special_ad_categories?: string[];
  special_ad_category_country?: string[];
  account_id?: string;
  start_time?: string;
  stop_time?: string;
  updated_time?: string;
  created_time?: string;
}

export interface MetaCampaign {
  id: string;
  name: string;
  status: EntityStatus;
  effectiveStatus?: string;
  objective?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  startTime?: string;
  stopTime?: string;
  updatedTime?: string;
  createdTime?: string;
}

interface MetaAdSetRaw {
  id: string;
  name?: string;
  status?: EntityStatus;
  effective_status?: string;
  campaign_id?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  bid_amount?: number | string;
  targeting?: unknown;
  promoted_object?: unknown;
  attribution_spec?: unknown;
  destination_type?: string;
  start_time?: string;
  end_time?: string;
  updated_time?: string;
}

export interface MetaAdSet {
  id: string;
  name: string;
  status: EntityStatus;
  effectiveStatus?: string;
  campaignId?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  optimizationGoal?: string;
  billingEvent?: string;
  bidAmount?: number;
  startTime?: string;
  endTime?: string;
  updatedTime?: string;
}

interface MetaAdRaw {
  id: string;
  name?: string;
  status?: EntityStatus;
  effective_status?: string;
  adset_id?: string;
  campaign_id?: string;
  creative?: { id?: string };
  bid_amount?: number | string;
  updated_time?: string;
}

interface MetaObjectOwnershipRaw {
  account_id?: string;
  campaign_id?: string;
  adset_id?: string;
}

export interface MetaObjectOwnership {
  actId?: string;
  campaignId?: string;
  adsetId?: string;
}

export interface MetaAd {
  id: string;
  name: string;
  status: EntityStatus;
  effectiveStatus?: string;
  adsetId?: string;
  campaignId?: string;
  creativeId?: string;
  updatedTime?: string;
}

// ===== Insights =====
export type DatePreset =
  | 'today'
  | 'yesterday'
  | 'last_7d'
  | 'last_30d'
  | 'maximum';

interface MetaActionRow {
  action_type: string;
  value: string;
}

interface MetaInsightsRaw {
  spend?: string;
  impressions?: string;
  clicks?: string;
  cpc?: string;
  cpm?: string;
  ctr?: string;
  reach?: string;
  actions?: MetaActionRow[];
  cost_per_action_type?: MetaActionRow[];
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

const EMPTY_INSIGHTS: InsightsSummary = {
  spend: 0,
  impressions: 0,
  clicks: 0,
  cpc: 0,
  cpm: 0,
  ctr: 0,
  orders: 0,
  cpa: 0,
  addToCart: 0,
  initiateCheckout: 0,
};

const ORDER_ACTION_GROUPS = [
  ['omni_purchase'],
  ['purchase'],
  [
    'offsite_conversion.fb_pixel_purchase',
    'onsite_conversion.purchase',
    'onsite_web_purchase',
    'onsite_web_app_purchase',
    'app_custom_event.fb_mobile_purchase',
    'web_in_store_purchase',
    'offline_conversion.purchase',
  ],
];

const ADD_TO_CART_ACTION_GROUPS = [
  ['omni_add_to_cart'],
  ['add_to_cart'],
  [
    'offsite_conversion.fb_pixel_add_to_cart',
    'onsite_conversion.add_to_cart',
    'onsite_web_add_to_cart',
    'onsite_web_app_add_to_cart',
    'app_custom_event.fb_mobile_add_to_cart',
    'web_in_store_add_to_cart',
  ],
];

const CHECKOUT_ACTION_GROUPS = [
  ['omni_initiated_checkout'],
  ['initiate_checkout'],
  [
    'offsite_conversion.fb_pixel_initiate_checkout',
    'onsite_conversion.initiate_checkout',
    'onsite_web_initiate_checkout',
    'onsite_web_app_initiate_checkout',
    'app_custom_event.fb_mobile_initiated_checkout',
    'web_in_store_initiate_checkout',
  ],
];

function actionMetric(
  actions: MetaActionRow[] | undefined,
  groups: string[][],
): number {
  if (!actions) return 0;
  const byType = new Map<string, number>();
  for (const action of actions) {
    byType.set(
      action.action_type,
      (byType.get(action.action_type) ?? 0) + (Number(action.value) || 0),
    );
  }
  for (const group of groups) {
    const value = group.reduce((sum, key) => sum + (byType.get(key) ?? 0), 0);
    if (value > 0) return value;
  }
  return 0;
}

function toInsightsSummary(row: MetaInsightsRaw): InsightsSummary {
  const spend = Number(row.spend ?? 0);
  const orders = actionMetric(row.actions, ORDER_ACTION_GROUPS);
  return {
    spend,
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    cpc: Number(row.cpc ?? 0),
    cpm: Number(row.cpm ?? 0),
    ctr: Number(row.ctr ?? 0),
    orders,
    cpa: orders > 0 ? spend / orders : 0,
    addToCart: actionMetric(row.actions, ADD_TO_CART_ACTION_GROUPS),
    initiateCheckout: actionMetric(row.actions, CHECKOUT_ACTION_GROUPS),
  };
}

// ===== HTTP =====
async function graph<T>(
  path: string,
  token: string,
  init: {
    method?: 'GET' | 'POST' | 'DELETE';
    query?: Record<string, string>;
    form?: Record<string, string>;
    json?: unknown;
  } = {},
): Promise<T> {
  const url = new URL(`${env.metaApiVersion}${path}`, `${env.metaGraphBase}/`);
  url.searchParams.set('access_token', token);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  }
  const method = init.method ?? 'GET';
  let body: string | undefined;
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers['content-type'] = 'application/json';
    } else if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    let err: MetaErrorEnvelope['error'] | undefined;
    try {
      err = (JSON.parse(text) as MetaErrorEnvelope).error;
    } catch {
      /* */
    }
    const friendly = err?.error_user_msg ?? err?.message;
    throw new MetaApiError(
      res.status,
      err?.code,
      err?.error_subcode,
      err?.type,
      err?.fbtrace_id,
      friendly ?? `Meta ${path} HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return JSON.parse(text) as T;
}

async function graphRoot<T>(
  token: string,
  init: {
    method?: 'POST';
    form?: Record<string, string>;
  },
): Promise<T> {
  const url = new URL(env.metaGraphBase);
  url.searchParams.set('access_token', token);
  const method = init.method ?? 'POST';
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.form) {
    body = new URLSearchParams(init.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    let err: MetaErrorEnvelope['error'] | undefined;
    try {
      err = (JSON.parse(text) as MetaErrorEnvelope).error;
    } catch {
      /* */
    }
    const friendly = err?.error_user_msg ?? err?.message;
    throw new MetaApiError(
      res.status,
      err?.code,
      err?.error_subcode,
      err?.type,
      err?.fbtrace_id,
      friendly ?? `Meta root HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return JSON.parse(text) as T;
}

function n(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

function toActId(accountId: string | undefined): string | undefined {
  if (!accountId) return undefined;
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
}

function pageAll<TRaw>(
  pathFn: () => Promise<MetaPagedEnvelope<TRaw>>,
): Promise<TRaw[]> {
  // Single page helper used by callers that want all pages; callers handle paging arg themselves.
  return pathFn().then((p) => p.data);
}
void pageAll;

// ===== Rename options =====
export interface RenameOptions {
  /** DEEP_COPY: 复制时自动加 "Copy of" 前缀;NO_RENAME: 完全保持原名;CUSTOMIZED: 用 prefix/suffix */
  rename_strategy?: 'DEEP_COPY_RENAME' | 'NO_RENAME' | 'ONLY_TOP_LEVEL_RENAME';
  rename_prefix?: string;
  rename_suffix?: string;
}

export interface CopyOptions {
  deepCopy?: boolean;
  startTime?: string; // ISO
  endTime?: string;   // ISO
  statusOption?: 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE';
  renameOptions?: RenameOptions;
}

export interface AsyncCopyInput extends CopyOptions {
  targetType: 'campaign' | 'adset' | 'ad';
  sourceId: string;
  targetAdAccountId?: string;
  targetCampaignId?: string;
  targetAdSetId?: string;
  requestName?: string;
}

export interface AsyncCopyRequestRef {
  requestName: string;
  targetType: AsyncCopyInput['targetType'];
}

export interface AsyncCopySubmitResult {
  requestSetId: string;
}

export interface AsyncCopyPollResult {
  status: 'pending' | 'success' | 'failed';
  newId?: string;
  error?: string;
}

interface MetaAsyncBatchRequest {
  relative_url: string;
  body: string;
  name: string;
}

interface MetaAsyncBatchCreateResponse {
  id?: string;
  async_request_set?: string | { id?: string };
  async_request_set_id?: string;
  async_batch_request_set_id?: string;
  request_set_id?: string;
}

interface MetaAsyncRequestSetRaw {
  id: string;
  name?: string;
  is_completed?: boolean;
  success_count?: number;
  error_count?: number;
  canceled_count?: number;
  in_progress_count?: number;
  total_count?: number;
}

interface MetaAsyncRequestRaw {
  id: string;
  name?: string;
  status?: string;
  result?: unknown;
  error?: unknown;
  input?: unknown;
  type?: string;
}

interface MetaBatchRequest {
  method: 'POST';
  relative_url: string;
  body: string;
  name: string;
}

interface MetaBatchResponseEntry {
  code?: number;
  body?: unknown;
  headers?: unknown;
}

function copyForm(opts: CopyOptions): Record<string, string> {
  const f: Record<string, string> = {};
  if (opts.deepCopy !== undefined) f['deep_copy'] = String(opts.deepCopy);
  if (opts.startTime) f['start_time'] = opts.startTime;
  if (opts.endTime) f['end_time'] = opts.endTime;
  if (opts.statusOption) f['status_option'] = opts.statusOption;
  if (opts.renameOptions && Object.keys(opts.renameOptions).length) {
    f['rename_options'] = JSON.stringify(opts.renameOptions);
  }
  return f;
}

function addFormValue(form: Record<string, string>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value) || typeof value === 'object') {
    form[key] = JSON.stringify(value);
    return;
  }
  form[key] = String(value);
}

function applyCopyName(name: string | undefined, opts: RenameOptions | undefined, isTopLevel: boolean): string {
  const base = name || 'Untitled';
  if (!isTopLevel && opts?.rename_strategy === 'ONLY_TOP_LEVEL_RENAME') return base;
  if (opts?.rename_strategy === 'NO_RENAME') return base;
  const prefix = opts?.rename_prefix ?? '';
  const suffix = opts?.rename_suffix ?? '';
  return prefix || suffix ? `${prefix}${base}${suffix}` : `Copy of ${base}`;
}

function copyCreateStatus(source: EntityStatus | undefined, opts: CopyOptions): 'ACTIVE' | 'PAUSED' {
  if (opts.statusOption === 'ACTIVE') return 'ACTIVE';
  if (opts.statusOption === 'INHERITED_FROM_SOURCE') {
    return source === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  }
  return 'PAUSED';
}

function futureIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return undefined;
  return t > Date.now() ? value : undefined;
}

function asyncCopyForm(input: AsyncCopyInput): Record<string, string> {
  const f =
    input.targetType === 'ad'
      ? {
        ...(input.statusOption ? { status_option: input.statusOption } : {}),
        ...(input.renameOptions && Object.keys(input.renameOptions).length
          ? { rename_options: JSON.stringify(input.renameOptions) }
          : {}),
      }
      : copyForm(input);
  if (input.targetType === 'campaign' && input.targetAdAccountId) {
    f['target_ad_account_id'] = input.targetAdAccountId;
  }
  if (input.targetType === 'adset' && input.targetCampaignId) {
    f['campaign_id'] = input.targetCampaignId;
  }
  if (input.targetType === 'ad' && input.targetAdSetId) {
    f['adset_id'] = input.targetAdSetId;
  }
  return f;
}

function asyncCopyRequest(input: AsyncCopyInput): MetaAsyncBatchRequest {
  const body = new URLSearchParams(asyncCopyForm(input)).toString();
  return {
    relative_url: `${input.sourceId}/copies`,
    body,
    name: input.requestName ?? 'copy',
  };
}

function graphBatchCopyRequest(input: AsyncCopyInput): MetaBatchRequest {
  return {
    method: 'POST',
    relative_url: `${env.metaApiVersion}/${input.sourceId}/copies`,
    body: new URLSearchParams(asyncCopyForm(input)).toString(),
    name: input.requestName ?? 'copy',
  };
}

function parseAsyncRequestSetId(r: MetaAsyncBatchCreateResponse): string | undefined {
  if (typeof r.id === 'string' && r.id) return r.id;
  if (typeof r.async_request_set === 'string' && r.async_request_set) return r.async_request_set;
  if (typeof r.async_request_set === 'object' && r.async_request_set?.id) {
    return r.async_request_set.id;
  }
  return r.async_request_set_id ?? r.async_batch_request_set_id ?? r.request_set_id;
}

function normalizeAsyncStatus(status: string | undefined): string {
  return (status ?? '').toUpperCase();
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractBodyCandidates(value: unknown): unknown[] {
  const parsed = parseMaybeJson(value);
  if (!parsed || typeof parsed !== 'object') return [parsed];
  const record = parsed as Record<string, unknown>;
  return [
    parsed,
    parseMaybeJson(record['body']),
    parseMaybeJson(record['response']),
    parseMaybeJson(record['result']),
  ].filter((item) => item !== undefined && item !== null);
}

function copiedIdFromPayload(value: unknown, targetType: AsyncCopyInput['targetType']): string | undefined {
  for (const item of extractBodyCandidates(value)) {
    if (!item || typeof item !== 'object') continue;
    const body = item as Record<string, unknown>;
    const adObjectIds = Array.isArray(body['ad_object_ids']) ? body['ad_object_ids'] : undefined;
    const candidate =
      targetType === 'campaign'
        ? body['copied_campaign_id']
        : targetType === 'adset'
          ? body['copied_adset_id']
          : body['copied_ad_id'];
    if (typeof candidate === 'string' && candidate) return candidate;
    const copiedFromObjectList = copiedIdFromAdObjectList(adObjectIds, targetType);
    if (copiedFromObjectList) return copiedFromObjectList;
    if (typeof body['id'] === 'string' && body['id']) return body['id'];
  }
  return undefined;
}

function copiedIdFromAdObjectList(
  adObjectIds: unknown[] | undefined,
  targetType: AsyncCopyInput['targetType'],
): string | undefined {
  if (!adObjectIds) return undefined;
  const preferredType =
    targetType === 'campaign' ? 'campaign' : targetType === 'adset' ? 'ad_set' : 'ad';
  for (const item of adObjectIds) {
    if (typeof item === 'string' && item) return item;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record['ad_object_type'] !== preferredType) continue;
    const copiedId = record['copied_id'];
    if (typeof copiedId === 'string' && copiedId) return copiedId;
  }
  for (const item of adObjectIds) {
    if (!item || typeof item !== 'object') continue;
    const copiedId = (item as Record<string, unknown>)['copied_id'];
    if (typeof copiedId === 'string' && copiedId) return copiedId;
  }
  return undefined;
}

function asyncRequestText(request: MetaAsyncRequestRaw): string {
  return [
    request.name,
    request.type,
    typeof request.input === 'string' ? request.input : JSON.stringify(request.input ?? ''),
  ].join(' ');
}

function pickCopyAsyncRequest(
  requests: MetaAsyncRequestRaw[],
  requestName?: string,
  index?: number,
): MetaAsyncRequestRaw | undefined {
  if (requestName) {
    return (
      requests.find((request) => request.name === requestName) ??
      (index !== undefined ? requests[index] : undefined)
    );
  }
  return (
    requests.find((request) => request.name === 'copy') ??
    requests.find((request) => asyncRequestText(request).includes('/copies')) ??
    requests[0]
  );
}

function errorText(value: unknown): string | undefined {
  const parsed = parseMaybeJson(value);
  if (!parsed) return undefined;
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed !== 'object') return String(parsed);
  const record = parsed as Record<string, unknown>;
  const nested = parseMaybeJson(record['error']);
  if (nested && nested !== parsed) return errorText(nested);
  const message = record['message'] ?? record['error_user_msg'] ?? record['body'];
  return typeof message === 'string' ? message : JSON.stringify(record).slice(0, 500);
}

function asyncCopyResultFromRequest(
  request: MetaAsyncRequestRaw | undefined,
  requestSetId: string,
  targetType: AsyncCopyInput['targetType'],
  hasSetError: boolean,
): AsyncCopyPollResult {
  if (!request) {
    if (hasSetError) {
      return { status: 'failed', error: `Meta async copy ${requestSetId} failed` };
    }
    return { status: 'pending' };
  }

  const reqStatus = normalizeAsyncStatus(request.status);
  if (
    reqStatus.startsWith('ERROR') ||
    reqStatus.includes('CANCELED') ||
    request.error
  ) {
    return {
      status: 'failed',
      error: errorText(request.error ?? request.result) ?? `Meta async request ${request.id} failed`,
    };
  }

  const newId = copiedIdFromPayload(request.result, targetType);
  if (newId) return { status: 'success', newId };

  if (hasSetError || reqStatus === 'SUCCESS') {
    return {
      status: 'failed',
      error: errorText(request.result) ?? `Meta async copy ${requestSetId} completed without copied id`,
    };
  }
  return { status: 'pending' };
}

function batchCopyResultFromEntry(
  entry: MetaBatchResponseEntry | undefined,
  requestName: string,
  targetType: AsyncCopyInput['targetType'],
): AsyncCopyPollResult {
  if (!entry) {
    return { status: 'failed', error: `Meta batch copy ${requestName} missing response` };
  }
  const code = entry.code ?? 0;
  if (code < 200 || code >= 300) {
    return {
      status: 'failed',
      error: errorText(entry.body) ?? `Meta batch copy ${requestName} HTTP ${code}`,
    };
  }
  const newId = copiedIdFromPayload(entry.body, targetType);
  if (newId) return { status: 'success', newId };
  return {
    status: 'failed',
    error: errorText(entry.body) ?? `Meta batch copy ${requestName} completed without copied id`,
  };
}

async function countAdsOnObjectEdge(
  token: string,
  objectId: string,
  max: number,
): Promise<number> {
  let count = 0;
  let after: string | undefined;
  do {
    const q: Record<string, string> = {
      fields: 'id',
      limit: String(Math.max(1, Math.min(100, max - count))),
    };
    if (after) q['after'] = after;
    const page = await graph<MetaPagedEnvelope<{ id: string }>>(`/${objectId}/ads`, token, {
      query: q,
    });
    count += page.data.length;
    if (count >= max) return count;
    after = page.paging?.cursors?.after;
    if (!page.paging?.next) break;
  } while (after);
  return count;
}

function copyCampaignCreateForm(source: MetaCampaignRaw, opts: CopyOptions, isTopLevel: boolean): Record<string, string> {
  const form: Record<string, string> = {
    name: applyCopyName(source.name ?? source.id, opts.renameOptions, isTopLevel),
    status: copyCreateStatus(source.status, opts),
    objective: source.objective ?? 'OUTCOME_SALES',
    special_ad_categories: JSON.stringify(source.special_ad_categories ?? []),
  };
  addFormValue(form, 'buying_type', source.buying_type ?? 'AUCTION');
  addFormValue(form, 'bid_strategy', source.bid_strategy);
  addFormValue(form, 'daily_budget', source.daily_budget);
  addFormValue(form, 'lifetime_budget', source.lifetime_budget);
  addFormValue(form, 'special_ad_category_country', source.special_ad_category_country);
  return form;
}

function copyAdSetCreateForm(
  source: MetaAdSetRaw,
  targetCampaignId: string,
  opts: CopyOptions,
  isTopLevel: boolean,
): Record<string, string> {
  const form: Record<string, string> = {
    name: applyCopyName(source.name ?? source.id, opts.renameOptions, isTopLevel),
    campaign_id: targetCampaignId,
    status: copyCreateStatus(source.status, opts),
  };
  addFormValue(form, 'billing_event', source.billing_event);
  addFormValue(form, 'optimization_goal', source.optimization_goal);
  addFormValue(form, 'bid_strategy', source.bid_strategy);
  addFormValue(form, 'bid_amount', source.bid_amount);
  addFormValue(form, 'daily_budget', source.daily_budget);
  addFormValue(form, 'lifetime_budget', source.lifetime_budget);
  addFormValue(form, 'targeting', source.targeting);
  addFormValue(form, 'promoted_object', source.promoted_object);
  addFormValue(form, 'attribution_spec', source.attribution_spec);
  addFormValue(form, 'destination_type', source.destination_type);
  addFormValue(form, 'start_time', opts.startTime ?? futureIso(source.start_time));
  addFormValue(form, 'end_time', opts.endTime ?? futureIso(source.end_time));
  return form;
}

function copyAdCreateForm(
  source: MetaAdRaw,
  targetAdSetId: string,
  opts: CopyOptions,
  isTopLevel: boolean,
): Record<string, string> {
  if (!source.creative?.id) {
    throw new MetaApiError(400, 100, undefined, undefined, undefined, `ad ${source.id} 缺 creative_id, 无法自建复制`);
  }
  const form: Record<string, string> = {
    name: applyCopyName(source.name ?? source.id, opts.renameOptions, isTopLevel),
    adset_id: targetAdSetId,
    status: copyCreateStatus(source.status, opts),
    creative: JSON.stringify({ creative_id: source.creative.id }),
  };
  addFormValue(form, 'bid_amount', source.bid_amount);
  return form;
}

async function readCampaignForCopy(token: string, campaignId: string): Promise<MetaCampaignRaw> {
  return graph<MetaCampaignRaw>(`/${campaignId}`, token, {
    query: {
      fields:
        'id,name,status,objective,buying_type,bid_strategy,daily_budget,lifetime_budget,special_ad_categories,special_ad_category_country,account_id',
    },
  });
}

async function readAdSetForCopy(token: string, adsetId: string): Promise<MetaAdSetRaw> {
  return graph<MetaAdSetRaw>(`/${adsetId}`, token, {
    query: {
      fields:
        'id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,bid_amount,targeting,promoted_object,attribution_spec,destination_type,start_time,end_time',
    },
  });
}

async function readAdForCopy(token: string, adId: string): Promise<MetaAdRaw> {
  return graph<MetaAdRaw>(`/${adId}`, token, {
    query: {
      fields: 'id,name,status,adset_id,campaign_id,creative{id},bid_amount',
    },
  });
}

async function listAdSetsForCopy(token: string, campaignId: string): Promise<MetaAdSetRaw[]> {
  const out: MetaAdSetRaw[] = [];
  let after: string | undefined;
  do {
    const q: Record<string, string> = {
      fields:
        'id,name,status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,bid_amount,targeting,promoted_object,attribution_spec,destination_type,start_time,end_time',
      limit: '100',
    };
    if (after) q['after'] = after;
    const page = await graph<MetaPagedEnvelope<MetaAdSetRaw>>(`/${campaignId}/adsets`, token, { query: q });
    out.push(...page.data);
    after = page.paging?.cursors?.after;
    if (!page.paging?.next) break;
  } while (after);
  return out;
}

async function listAdsForCopy(token: string, adsetId: string): Promise<MetaAdRaw[]> {
  const out: MetaAdRaw[] = [];
  let after: string | undefined;
  do {
    const q: Record<string, string> = {
      fields: 'id,name,status,adset_id,campaign_id,creative{id},bid_amount',
      limit: '100',
    };
    if (after) q['after'] = after;
    const page = await graph<MetaPagedEnvelope<MetaAdRaw>>(`/${adsetId}/ads`, token, { query: q });
    out.push(...page.data);
    after = page.paging?.cursors?.after;
    if (!page.paging?.next) break;
  } while (after);
  return out;
}

// ===== 主对象 =====
export const meta = {
  async me(token: string): Promise<{ id: string; name: string }> {
    if (FAKE_MODE) return { id: 'mock_fb_user_1', name: 'Mock FB User' };
    return graph<{ id: string; name: string }>('/me', token, { query: { fields: 'id,name' } });
  },

  async listUserAdAccounts(token: string): Promise<
    Array<{
      metaActId: string;
      name: string;
      currency?: string;
      timezoneName?: string;
      businessCountryCode?: string;
      status: 'active' | 'disabled' | 'closed' | 'pending';
    }>
  > {
    if (FAKE_MODE) {
      const countries = ['US', 'GB', 'DE', 'JP', 'SG', 'AU'];
      const timezones = [
        'America/Los_Angeles',
        'Europe/London',
        'Europe/Berlin',
        'Asia/Tokyo',
        'Asia/Singapore',
        'Australia/Sydney',
      ];
      const currencies = ['USD', 'GBP', 'EUR', 'JPY', 'SGD', 'AUD'];
      return Array.from({ length: 6 }, (_, index) => ({
        metaActId: `act_mock_${index}`,
        name: `Mock Ad Account ${index}`,
        currency: currencies[index % currencies.length],
        timezoneName: timezones[index % timezones.length],
        businessCountryCode: countries[index % countries.length],
        status: 'active' as const,
      }));
    }
    const out: Array<{
      metaActId: string;
      name: string;
      currency?: string;
      timezoneName?: string;
      businessCountryCode?: string;
      status: 'active' | 'disabled' | 'closed' | 'pending';
    }> = [];
    let after: string | undefined;
    do {
      const q: Record<string, string> = {
        fields: 'id,account_id,name,currency,timezone_name,business_country_code,account_status',
        limit: '100',
      };
      if (after) q['after'] = after;
      const page = await graph<MetaPagedEnvelope<MetaAdAccount>>('/me/adaccounts', token, { query: q });
      for (const a of page.data) {
        out.push({
          metaActId: a.id,
          name: a.name ?? a.id,
          ...(a.currency ? { currency: a.currency } : {}),
          ...(a.timezone_name ? { timezoneName: a.timezone_name } : {}),
          ...(a.business_country_code ? { businessCountryCode: a.business_country_code } : {}),
          status: ACCT_STATUS_MAP[a.account_status ?? 1] ?? 'disabled',
        });
      }
      after = page.paging?.cursors?.after;
      if (!page.paging?.next) break;
    } while (after);
    return out;
  },

  async getObjectOwnership(
    token: string,
    targetType: 'campaign' | 'adset' | 'ad',
    objectId: string,
  ): Promise<MetaObjectOwnership> {
    if (FAKE_MODE) return fakeMeta.getParent(objectId);
    const fields =
      targetType === 'campaign'
        ? 'account_id'
        : targetType === 'adset'
          ? 'account_id,campaign_id'
          : 'account_id,campaign_id,adset_id';
    const raw = await graph<MetaObjectOwnershipRaw>(`/${objectId}`, token, {
      query: { fields },
    });
    return {
      ...(toActId(raw.account_id) ? { actId: toActId(raw.account_id)! } : {}),
      ...(raw.campaign_id ? { campaignId: raw.campaign_id } : {}),
      ...(raw.adset_id ? { adsetId: raw.adset_id } : {}),
    };
  },

  async countCopiedChildAds(
    token: string,
    input: Pick<AsyncCopyInput, 'targetType' | 'sourceId' | 'deepCopy'>,
    max: number,
  ): Promise<number> {
    if (FAKE_MODE || input.targetType === 'ad' || input.deepCopy === false) return 0;
    return countAdsOnObjectEdge(token, input.sourceId, max);
  },

  async submitAsyncCopy(
    token: string,
    metaActId: string,
    input: AsyncCopyInput,
  ): Promise<AsyncCopySubmitResult> {
    return this.submitAsyncCopyBatch(token, metaActId, [input]);
  },

  async submitAsyncCopyBatch(
    token: string,
    metaActId: string,
    inputs: AsyncCopyInput[],
  ): Promise<AsyncCopySubmitResult> {
    if (FAKE_MODE) {
      throw new Error('submitAsyncCopyBatch is not used in fake mode');
    }
    if (inputs.length === 0) {
      throw new MetaApiError(
        500,
        undefined,
        undefined,
        undefined,
        undefined,
        'async copy: no requests to submit',
      );
    }
    const requests = inputs.map((item) => asyncCopyRequest(item));
    console.info(
      `[meta-async-copy] submit account=${metaActId} requests=${requests.length} names=${requests
        .map((request) => request.name)
        .join(',')}`,
    );
    const r = await graph<MetaAsyncBatchCreateResponse>(
      `/${metaActId}/async_batch_requests`,
      token,
      {
        method: 'POST',
        form: {
          name: inputs.length === 1
            ? inputs[0]!.requestName ?? `copy_${inputs[0]!.targetType}_${inputs[0]!.sourceId}`
            : `copy_batch_${Date.now()}`,
          adbatch: JSON.stringify(requests),
        },
      },
    );
    const requestSetId = parseAsyncRequestSetId(r);
    if (!requestSetId) {
      throw new MetaApiError(
        500,
        undefined,
        undefined,
        undefined,
        undefined,
        `async copy: missing request set id from ${JSON.stringify(r).slice(0, 300)}`,
      );
    }
    return { requestSetId };
  },

  async pollAsyncCopy(
    token: string,
    requestSetId: string,
    targetType: AsyncCopyInput['targetType'],
    requestName?: string,
  ): Promise<AsyncCopyPollResult> {
    const result = await this.pollAsyncCopyBatch(token, requestSetId, [
      { requestName: requestName ?? 'copy', targetType },
    ]);
    return result[requestName ?? 'copy'] ?? { status: 'pending' };
  },

  async pollAsyncCopyBatch(
    token: string,
    requestSetId: string,
    requestsToPoll: AsyncCopyRequestRef[],
  ): Promise<Record<string, AsyncCopyPollResult>> {
    if (FAKE_MODE) {
      throw new Error('pollAsyncCopyBatch is not used in fake mode');
    }
    const set = await graph<MetaAsyncRequestSetRaw>(`/${requestSetId}`, token, {
      query: {
        fields: 'id,name,is_completed,success_count,error_count,canceled_count,in_progress_count,total_count',
      },
    });
    const hasSetError = (set.error_count ?? 0) > 0 || (set.canceled_count ?? 0) > 0;
    const counted = (set.success_count ?? 0) + (set.error_count ?? 0) + (set.canceled_count ?? 0);
    const total = set.total_count ?? 0;
    const setDone =
      set.is_completed === true ||
      (total > 0 && counted >= total && (set.in_progress_count ?? 0) === 0);

    if (!setDone) {
      return Object.fromEntries(
        requestsToPoll.map((request) => [request.requestName, { status: 'pending' as const }]),
      );
    }

    const reqPage = await graph<MetaPagedEnvelope<MetaAsyncRequestRaw>>(
      `/${requestSetId}/requests`,
      token,
      { query: { fields: 'id,name,status,result,error,input,type', limit: '100' } },
    );
    const out: Record<string, AsyncCopyPollResult> = {};
    for (const [index, expected] of requestsToPoll.entries()) {
      const request = pickCopyAsyncRequest(reqPage.data, expected.requestName, index);
      out[expected.requestName] = asyncCopyResultFromRequest(
        request,
        requestSetId,
        expected.targetType,
        hasSetError,
      );
    }
    return out;
  },

  async copyBatch(
    token: string,
    inputs: AsyncCopyInput[],
  ): Promise<Record<string, AsyncCopyPollResult>> {
    if (FAKE_MODE) {
      throw new Error('copyBatch is not used in fake mode');
    }
    if (inputs.length === 0) return {};
    const requests = inputs.map((item) => graphBatchCopyRequest(item));
    console.info(
      `[meta-copy-batch] submit requests=${requests.length} names=${requests
        .map((request) => request.name)
        .join(',')}`,
    );
    const entries = await graphRoot<MetaBatchResponseEntry[]>(token, {
      method: 'POST',
      form: {
        batch: JSON.stringify(requests),
        include_headers: 'false',
      },
    });
    const out: Record<string, AsyncCopyPollResult> = {};
    for (const [index, input] of inputs.entries()) {
      const requestName = input.requestName ?? 'copy';
      out[requestName] = batchCopyResultFromEntry(entries[index], requestName, input.targetType);
    }
    return out;
  },

  // ----- Campaign -----
  async listCampaigns(
    token: string,
    metaActId: string,
    limit = 100,
  ): Promise<MetaCampaign[]> {
    if (FAKE_MODE) return fakeMeta.listCampaigns(metaActId);
    const out: MetaCampaign[] = [];
    let after: string | undefined;
    do {
      const q: Record<string, string> = {
        fields:
          'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,updated_time,created_time',
        limit: String(limit),
      };
      if (after) q['after'] = after;
      const page = await graph<MetaPagedEnvelope<MetaCampaignRaw>>(
        `/${metaActId}/campaigns`,
        token,
        { query: q },
      );
      for (const c of page.data) {
        out.push({
          id: c.id,
          name: c.name ?? c.id,
          status: c.status ?? 'PAUSED',
          ...(c.effective_status ? { effectiveStatus: c.effective_status } : {}),
          ...(c.objective ? { objective: c.objective } : {}),
          ...(n(c.daily_budget) !== undefined ? { dailyBudget: n(c.daily_budget)! } : {}),
          ...(n(c.lifetime_budget) !== undefined ? { lifetimeBudget: n(c.lifetime_budget)! } : {}),
          ...(c.start_time ? { startTime: c.start_time } : {}),
          ...(c.stop_time ? { stopTime: c.stop_time } : {}),
          ...(c.updated_time ? { updatedTime: c.updated_time } : {}),
          ...(c.created_time ? { createdTime: c.created_time } : {}),
        });
      }
      after = page.paging?.cursors?.after;
      if (!page.paging?.next) break;
    } while (after);
    return out;
  },

  async setCampaignStatus(
    token: string,
    campaignId: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ): Promise<void> {
    if (FAKE_MODE) {
      fakeMeta.setStatus(campaignId, status);
      return;
    }
    await graph<{ success: boolean }>(`/${campaignId}`, token, {
      method: 'POST',
      form: { status },
    });
  },

  async customCopyCampaign(
    token: string,
    metaActId: string,
    campaignId: string,
    opts: CopyOptions & { targetAdAccountId?: string } = {},
  ): Promise<{ newCampaignId: string }> {
    if (FAKE_MODE) {
      return { newCampaignId: fakeMeta.copyCampaign(campaignId, opts.renameOptions) };
    }
    const targetActId = toActId(opts.targetAdAccountId ?? metaActId);
    if (!targetActId) {
      throw new MetaApiError(400, 100, undefined, undefined, undefined, 'customCopyCampaign: 缺 target ad account');
    }
    const source = await readCampaignForCopy(token, campaignId);
    const created = await graph<{ id?: string }>(`/${targetActId}/campaigns`, token, {
      method: 'POST',
      form: copyCampaignCreateForm(source, opts, true),
    });
    if (!created.id) {
      throw new MetaApiError(500, undefined, undefined, undefined, undefined, 'customCopyCampaign: 缺 new campaign id');
    }

    if (opts.deepCopy !== false) {
      const adsets = await listAdSetsForCopy(token, campaignId);
      for (const adset of adsets) {
        const newAdSet = await meta.createAdSetFromSource(token, targetActId, adset, created.id, opts, false);
        const ads = await listAdsForCopy(token, adset.id);
        for (const ad of ads) {
          await meta.createAdFromSource(token, targetActId, ad, newAdSet.newAdSetId, opts, false);
        }
      }
    }

    return { newCampaignId: created.id };
  },

  async copyCampaign(
    token: string,
    campaignId: string,
    opts: CopyOptions & { targetAdAccountId?: string } = {},
  ): Promise<{ newCampaignId: string }> {
    if (FAKE_MODE) {
      return { newCampaignId: fakeMeta.copyCampaign(campaignId, opts.renameOptions) };
    }
    const form = copyForm(opts);
    if (opts.targetAdAccountId) form['target_ad_account_id'] = opts.targetAdAccountId;
    const r = await graph<{ copied_campaign_id?: string; ad_object_ids?: string[] }>(
      `/${campaignId}/copies`,
      token,
      { method: 'POST', form },
    );
    if (!r.copied_campaign_id) {
      throw new MetaApiError(500, undefined, undefined, undefined, undefined, 'copy: 缺 copied_campaign_id');
    }
    return { newCampaignId: r.copied_campaign_id };
  },

  async removeCampaign(
    token: string,
    campaignId: string,
    opts: { hard?: boolean } = {},
  ): Promise<void> {
    if (FAKE_MODE) {
      fakeMeta.remove(campaignId, opts.hard === true);
      return;
    }
    if (opts.hard) {
      await graph<{ success: boolean }>(`/${campaignId}`, token, { method: 'DELETE' });
    } else {
      await meta.setCampaignStatus(token, campaignId, 'ARCHIVED');
    }
  },

  async setBudget(
    token: string,
    objectId: string,
    budget: { daily?: number; lifetime?: number },
  ): Promise<void> {
    if (FAKE_MODE) {
      fakeMeta.setBudget(objectId, budget.daily, budget.lifetime);
      return;
    }
    const form: Record<string, string> = {};
    if (budget.daily !== undefined) form['daily_budget'] = String(budget.daily);
    if (budget.lifetime !== undefined) form['lifetime_budget'] = String(budget.lifetime);
    if (!Object.keys(form).length) {
      throw new Error('setBudget: 至少传 daily 或 lifetime');
    }
    if (form['daily_budget'] && form['lifetime_budget']) {
      throw new Error('setBudget: daily 与 lifetime 二选一');
    }
    await graph<{ success: boolean }>(`/${objectId}`, token, { method: 'POST', form });
  },

  // ----- AdSet -----
  async listAdSets(
    token: string,
    campaignId: string,
    limit = 100,
  ): Promise<MetaAdSet[]> {
    if (FAKE_MODE) return fakeMeta.listAdSets(campaignId);
    const out: MetaAdSet[] = [];
    let after: string | undefined;
    do {
      const q: Record<string, string> = {
        fields:
          'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_amount,start_time,end_time,updated_time',
        limit: String(limit),
      };
      if (after) q['after'] = after;
      const page = await graph<MetaPagedEnvelope<MetaAdSetRaw>>(
        `/${campaignId}/adsets`,
        token,
        { query: q },
      );
      for (const a of page.data) {
        out.push({
          id: a.id,
          name: a.name ?? a.id,
          status: a.status ?? 'PAUSED',
          ...(a.effective_status ? { effectiveStatus: a.effective_status } : {}),
          ...(a.campaign_id ? { campaignId: a.campaign_id } : {}),
          ...(n(a.daily_budget) !== undefined ? { dailyBudget: n(a.daily_budget)! } : {}),
          ...(n(a.lifetime_budget) !== undefined ? { lifetimeBudget: n(a.lifetime_budget)! } : {}),
          ...(a.optimization_goal ? { optimizationGoal: a.optimization_goal } : {}),
          ...(a.billing_event ? { billingEvent: a.billing_event } : {}),
          ...(n(a.bid_amount) !== undefined ? { bidAmount: n(a.bid_amount)! } : {}),
          ...(a.start_time ? { startTime: a.start_time } : {}),
          ...(a.end_time ? { endTime: a.end_time } : {}),
          ...(a.updated_time ? { updatedTime: a.updated_time } : {}),
        });
      }
      after = page.paging?.cursors?.after;
      if (!page.paging?.next) break;
    } while (after);
    return out;
  },

  async setAdSetStatus(
    token: string,
    adsetId: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ): Promise<void> {
    if (FAKE_MODE) {
      fakeMeta.setStatus(adsetId, status);
      return;
    }
    await graph<{ success: boolean }>(`/${adsetId}`, token, {
      method: 'POST',
      form: { status },
    });
  },

  async createAdSetFromSource(
    token: string,
    metaActId: string,
    source: MetaAdSetRaw,
    targetCampaignId: string,
    opts: CopyOptions,
    isTopLevel: boolean,
  ): Promise<{ newAdSetId: string }> {
    const targetActId = toActId(metaActId);
    if (!targetActId) {
      throw new MetaApiError(400, 100, undefined, undefined, undefined, 'createAdSetFromSource: 缺 ad account');
    }
    const created = await graph<{ id?: string }>(`/${targetActId}/adsets`, token, {
      method: 'POST',
      form: copyAdSetCreateForm(source, targetCampaignId, opts, isTopLevel),
    });
    if (!created.id) {
      throw new MetaApiError(500, undefined, undefined, undefined, undefined, 'createAdSetFromSource: 缺 new adset id');
    }
    return { newAdSetId: created.id };
  },

  async customCopyAdSet(
    token: string,
    metaActId: string,
    adsetId: string,
    opts: CopyOptions & { targetCampaignId?: string } = {},
  ): Promise<{ newAdSetId: string }> {
    if (FAKE_MODE) {
      return { newAdSetId: fakeMeta.copyAdSet(adsetId, opts.renameOptions) };
    }
    const source = await readAdSetForCopy(token, adsetId);
    const targetCampaignId = opts.targetCampaignId ?? source.campaign_id;
    if (!targetCampaignId) {
      throw new MetaApiError(400, 100, undefined, undefined, undefined, `adset ${adsetId} 缺 campaign_id, 无法自建复制`);
    }
    const created = await meta.createAdSetFromSource(token, metaActId, source, targetCampaignId, opts, true);
    if (opts.deepCopy !== false) {
      const ads = await listAdsForCopy(token, adsetId);
      for (const ad of ads) {
        await meta.createAdFromSource(token, metaActId, ad, created.newAdSetId, opts, false);
      }
    }
    return created;
  },

  async copyAdSet(
    token: string,
    adsetId: string,
    opts: CopyOptions & { targetCampaignId?: string } = {},
  ): Promise<{ newAdSetId: string }> {
    if (FAKE_MODE) {
      return { newAdSetId: fakeMeta.copyAdSet(adsetId, opts.renameOptions) };
    }
    const form = copyForm(opts);
    if (opts.targetCampaignId) form['campaign_id'] = opts.targetCampaignId;
    const r = await graph<{ copied_adset_id?: string }>(`/${adsetId}/copies`, token, {
      method: 'POST',
      form,
    });
    if (!r.copied_adset_id) {
      throw new MetaApiError(500, undefined, undefined, undefined, undefined, 'copyAdSet: 缺 copied_adset_id');
    }
    return { newAdSetId: r.copied_adset_id };
  },

  async removeAdSet(
    token: string,
    adsetId: string,
    opts: { hard?: boolean } = {},
  ): Promise<void> {
    if (FAKE_MODE) {
      fakeMeta.remove(adsetId, opts.hard === true);
      return;
    }
    if (opts.hard) {
      await graph<{ success: boolean }>(`/${adsetId}`, token, { method: 'DELETE' });
    } else {
      await meta.setAdSetStatus(token, adsetId, 'ARCHIVED');
    }
  },

  // ----- Ad -----
  async listAds(token: string, adsetId: string, limit = 100): Promise<MetaAd[]> {
    if (FAKE_MODE) return fakeMeta.listAds(adsetId);
    const out: MetaAd[] = [];
    let after: string | undefined;
    do {
      const q: Record<string, string> = {
        fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id},updated_time',
        limit: String(limit),
      };
      if (after) q['after'] = after;
      const page = await graph<MetaPagedEnvelope<MetaAdRaw>>(`/${adsetId}/ads`, token, { query: q });
      for (const a of page.data) {
        out.push({
          id: a.id,
          name: a.name ?? a.id,
          status: a.status ?? 'PAUSED',
          ...(a.effective_status ? { effectiveStatus: a.effective_status } : {}),
          ...(a.adset_id ? { adsetId: a.adset_id } : {}),
          ...(a.campaign_id ? { campaignId: a.campaign_id } : {}),
          ...(a.creative?.id ? { creativeId: a.creative.id } : {}),
          ...(a.updated_time ? { updatedTime: a.updated_time } : {}),
        });
      }
      after = page.paging?.cursors?.after;
      if (!page.paging?.next) break;
    } while (after);
    return out;
  },

  async setAdStatus(
    token: string,
    adId: string,
    status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  ): Promise<void> {
    if (FAKE_MODE) {
      fakeMeta.setStatus(adId, status);
      return;
    }
    await graph<{ success: boolean }>(`/${adId}`, token, {
      method: 'POST',
      form: { status },
    });
  },

  async createAdFromSource(
    token: string,
    metaActId: string,
    source: MetaAdRaw,
    targetAdSetId: string,
    opts: CopyOptions,
    isTopLevel: boolean,
  ): Promise<{ newAdId: string }> {
    const targetActId = toActId(metaActId);
    if (!targetActId) {
      throw new MetaApiError(400, 100, undefined, undefined, undefined, 'createAdFromSource: 缺 ad account');
    }
    const created = await graph<{ id?: string }>(`/${targetActId}/ads`, token, {
      method: 'POST',
      form: copyAdCreateForm(source, targetAdSetId, opts, isTopLevel),
    });
    if (!created.id) {
      throw new MetaApiError(500, undefined, undefined, undefined, undefined, 'createAdFromSource: 缺 new ad id');
    }
    return { newAdId: created.id };
  },

  async customCopyAd(
    token: string,
    metaActId: string,
    adId: string,
    opts: CopyOptions & { targetAdSetId?: string } = {},
  ): Promise<{ newAdId: string }> {
    if (FAKE_MODE) {
      return { newAdId: fakeMeta.copyAd(adId, opts.renameOptions) };
    }
    const source = await readAdForCopy(token, adId);
    const targetAdSetId = opts.targetAdSetId ?? source.adset_id;
    if (!targetAdSetId) {
      throw new MetaApiError(400, 100, undefined, undefined, undefined, `ad ${adId} 缺 adset_id, 无法自建复制`);
    }
    return meta.createAdFromSource(token, metaActId, source, targetAdSetId, opts, true);
  },

  async copyAd(
    token: string,
    adId: string,
    opts: { targetAdSetId?: string; statusOption?: CopyOptions['statusOption']; renameOptions?: RenameOptions } = {},
  ): Promise<{ newAdId: string }> {
    if (FAKE_MODE) {
      return { newAdId: fakeMeta.copyAd(adId, opts.renameOptions) };
    }
    const form: Record<string, string> = {};
    if (opts.targetAdSetId) form['adset_id'] = opts.targetAdSetId;
    if (opts.statusOption) form['status_option'] = opts.statusOption;
    if (opts.renameOptions && Object.keys(opts.renameOptions).length) {
      form['rename_options'] = JSON.stringify(opts.renameOptions);
    }
    const r = await graph<{ copied_ad_id?: string; ad_object_ids?: string[] }>(
      `/${adId}/copies`,
      token,
      { method: 'POST', form },
    );
    // Meta /{ad_id}/copies 通常返回 ad_object_ids:[copyId]
    const newId = r.copied_ad_id ?? r.ad_object_ids?.[0];
    if (!newId) {
      throw new MetaApiError(500, undefined, undefined, undefined, undefined, 'copyAd: 缺 copied id');
    }
    return { newAdId: newId };
  },

  async removeAd(
    token: string,
    adId: string,
    opts: { hard?: boolean } = {},
  ): Promise<void> {
    if (FAKE_MODE) {
      fakeMeta.remove(adId, opts.hard === true);
      return;
    }
    if (opts.hard) {
      await graph<{ success: boolean }>(`/${adId}`, token, { method: 'DELETE' });
    } else {
      await meta.setAdStatus(token, adId, 'ARCHIVED');
    }
  },

  // ----- Insights -----
  /**
   * 拉对象级 insights, 解析 actions → orders/atc/checkout。
   * objectId 可以是 act_xxx / campaign_id / adset_id / ad_id。
   */
  async getInsights(
    token: string,
    objectId: string,
    datePreset: DatePreset = 'last_7d',
  ): Promise<InsightsSummary> {
    if (FAKE_MODE) return fakeMeta.getInsights(objectId, datePreset);
    const q: Record<string, string> = {
      date_preset: datePreset,
      fields: 'spend,impressions,clicks,cpc,cpm,ctr,reach,actions,cost_per_action_type',
    };
    const r = await graph<MetaPagedEnvelope<MetaInsightsRaw>>(`/${objectId}/insights`, token, {
      query: q,
    });
    const row = r.data[0];
    if (!row) return EMPTY_INSIGHTS;
    return toInsightsSummary(row);
  },

  /** 批量拉同账户下所有 children 的 insights, 一次 API + level breakdown */
  async getInsightsByChild(
    token: string,
    metaActId: string,
    level: 'campaign' | 'adset' | 'ad',
    datePreset: DatePreset = 'last_7d',
  ): Promise<Record<string, InsightsSummary>> {
    if (FAKE_MODE) return fakeMeta.getInsightsByChild(metaActId, level, datePreset);
    const baseQuery: Record<string, string> = {
      date_preset: datePreset,
      level,
      fields:
        (level === 'campaign'
          ? 'campaign_id,'
          : level === 'adset'
            ? 'adset_id,'
            : 'ad_id,') +
        'spend,impressions,clicks,cpc,cpm,ctr,reach,actions,cost_per_action_type',
      limit: '500',
    };
    const out: Record<string, InsightsSummary> = {};
    let after: string | undefined;
    do {
      const query = { ...baseQuery };
      if (after) query['after'] = after;
      const page = await graph<
        MetaPagedEnvelope<MetaInsightsRaw & { campaign_id?: string; adset_id?: string; ad_id?: string }>
      >(`/${metaActId}/insights`, token, { query });
      for (const row of page.data) {
        const key = (row.campaign_id ?? row.adset_id ?? row.ad_id ?? '') as string;
        if (!key) continue;
        out[key] = toInsightsSummary(row);
      }
      after = page.paging?.cursors?.after;
      if (!page.paging?.next) break;
    } while (after);
    return out;
  },
};
