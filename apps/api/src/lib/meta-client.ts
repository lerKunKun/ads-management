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
  daily_budget?: string;
  lifetime_budget?: string;
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
  bid_amount?: number | string;
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
  updated_time?: string;
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
  | 'lifetime'
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

// 订单/加购/结账匹配的 action_type 前缀
const ORDER_ACTIONS = [
  'purchase',
  'omni_purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_web_purchase',
  'app_custom_event.fb_mobile_purchase',
];
const ADD_TO_CART_ACTIONS = [
  'add_to_cart',
  'omni_add_to_cart',
  'offsite_conversion.fb_pixel_add_to_cart',
];
const CHECKOUT_ACTIONS = [
  'initiate_checkout',
  'omni_initiated_checkout',
  'offsite_conversion.fb_pixel_initiate_checkout',
];

function sumActions(actions: MetaActionRow[] | undefined, keys: string[]): number {
  if (!actions) return 0;
  let s = 0;
  for (const a of actions) {
    if (keys.includes(a.action_type)) s += Number(a.value) || 0;
  }
  return s;
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

function n(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
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
      status: 'active' | 'disabled' | 'closed' | 'pending';
    }>
  > {
    if (FAKE_MODE) return [];
    const out: Array<{
      metaActId: string;
      name: string;
      currency?: string;
      status: 'active' | 'disabled' | 'closed' | 'pending';
    }> = [];
    let after: string | undefined;
    do {
      const q: Record<string, string> = {
        fields: 'id,account_id,name,currency,account_status',
        limit: '100',
      };
      if (after) q['after'] = after;
      const page = await graph<MetaPagedEnvelope<MetaAdAccount>>('/me/adaccounts', token, { query: q });
      for (const a of page.data) {
        out.push({
          metaActId: a.id,
          name: a.name ?? a.id,
          ...(a.currency ? { currency: a.currency } : {}),
          status: ACCT_STATUS_MAP[a.account_status ?? 1] ?? 'disabled',
        });
      }
      after = page.paging?.cursors?.after;
      if (!page.paging?.next) break;
    } while (after);
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
    const spend = Number(row.spend ?? 0);
    const orders = sumActions(row.actions, ORDER_ACTIONS);
    return {
      spend,
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      cpc: Number(row.cpc ?? 0),
      cpm: Number(row.cpm ?? 0),
      ctr: Number(row.ctr ?? 0),
      orders,
      cpa: orders > 0 ? spend / orders : 0,
      addToCart: sumActions(row.actions, ADD_TO_CART_ACTIONS),
      initiateCheckout: sumActions(row.actions, CHECKOUT_ACTIONS),
    };
  },

  /** 批量拉同账户下所有 children 的 insights, 一次 API + level breakdown */
  async getInsightsByChild(
    token: string,
    metaActId: string,
    level: 'campaign' | 'adset' | 'ad',
    datePreset: DatePreset = 'last_7d',
  ): Promise<Record<string, InsightsSummary>> {
    if (FAKE_MODE) return fakeMeta.getInsightsByChild(metaActId, level, datePreset);
    const q: Record<string, string> = {
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
    const r = await graph<MetaPagedEnvelope<MetaInsightsRaw & { campaign_id?: string; adset_id?: string; ad_id?: string }>>(
      `/${metaActId}/insights`,
      token,
      { query: q },
    );
    const out: Record<string, InsightsSummary> = {};
    for (const row of r.data) {
      const key = (row.campaign_id ?? row.adset_id ?? row.ad_id ?? '') as string;
      if (!key) continue;
      const spend = Number(row.spend ?? 0);
      const orders = sumActions(row.actions, ORDER_ACTIONS);
      out[key] = {
        spend,
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        cpc: Number(row.cpc ?? 0),
        cpm: Number(row.cpm ?? 0),
        ctr: Number(row.ctr ?? 0),
        orders,
        cpa: orders > 0 ? spend / orders : 0,
        addToCart: sumActions(row.actions, ADD_TO_CART_ACTIONS),
        initiateCheckout: sumActions(row.actions, CHECKOUT_ACTIONS),
      };
    }
    return out;
  },
};
