/**
 * Mock Meta 三层数据。仅 META_FAKE=1 启用。
 * 一个 ad_account → 6 campaign → 每 campaign 2-3 adset → 每 adset 2-4 ad。
 * insights 按 (objectId, datePreset) 稳定生成(同输入同输出),让 UI 数据相对真实。
 */
import type {
  MetaCampaign,
  MetaAdSet,
  MetaAd,
  InsightsSummary,
  RenameOptions,
  DatePreset,
  EntityStatus,
} from './meta-client';

export const FAKE_MODE = process.env['META_FAKE'] === '1';

// ===== 全局存储 =====
const campaignsByActId = new Map<string, MetaCampaign[]>();
const adsetsByCampaign = new Map<string, MetaAdSet[]>();
const adsByAdset = new Map<string, MetaAd[]>();
const parentChain = new Map<string, { actId?: string; campaignId?: string; adsetId?: string }>();

function inferParent(objectId: string): { actId?: string; campaignId?: string; adsetId?: string } {
  const campaign = objectId.match(/^mock_camp_(.+)_\d+$/);
  if (campaign?.[1]) return { actId: campaign[1] };

  const adset = objectId.match(/^mock_adset_(.+)_\d+$/);
  if (adset?.[1]) {
    const campaignId = adset[1];
    const parent = parentChain.get(campaignId) ?? inferParent(campaignId);
    return {
      ...(parent.actId ? { actId: parent.actId } : {}),
      campaignId,
    };
  }

  const ad = objectId.match(/^mock_ad_(.+)_\d+$/);
  if (ad?.[1]) {
    const adsetId = ad[1];
    const parent = parentChain.get(adsetId) ?? inferParent(adsetId);
    return {
      ...(parent.actId ? { actId: parent.actId } : {}),
      ...(parent.campaignId ? { campaignId: parent.campaignId } : {}),
      adsetId,
    };
  }

  return {};
}

function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

// ===== Campaign =====
function ensureCampaigns(metaActId: string): MetaCampaign[] {
  let list = campaignsByActId.get(metaActId);
  if (list) return list;
  list = [];
  const objs = ['OUTCOME_LEADS', 'OUTCOME_TRAFFIC', 'OUTCOME_SALES', 'OUTCOME_ENGAGEMENT'] as const;
  for (let i = 0; i < 6; i++) {
    const id = `mock_camp_${metaActId}_${i}`;
    list.push({
      id,
      name: `Mock Campaign ${i} (${metaActId})`,
      status: i % 2 === 0 ? 'ACTIVE' : 'PAUSED',
      effectiveStatus: i % 2 === 0 ? 'ACTIVE' : 'PAUSED',
      objective: objs[i % 4],
      dailyBudget: (10 + i * 5) * 100,
      startTime: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
      updatedTime: new Date().toISOString(),
      createdTime: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    });
    parentChain.set(id, { actId: metaActId });
  }
  campaignsByActId.set(metaActId, list);
  return list;
}

// ===== AdSet =====
function ensureAdSets(campaignId: string): MetaAdSet[] {
  let list = adsetsByCampaign.get(campaignId);
  if (list) return list;
  const parent = parentChain.get(campaignId);
  list = [];
  const n = 2 + (fnv1a(campaignId) % 2); // 2 or 3
  const goals = ['REACH', 'LINK_CLICKS', 'CONVERSIONS', 'POST_ENGAGEMENT'] as const;
  for (let i = 0; i < n; i++) {
    const id = `mock_adset_${campaignId}_${i}`;
    list.push({
      id,
      name: `AdSet ${i} of ${campaignId.slice(-6)}`,
      status: i === 0 ? 'ACTIVE' : 'PAUSED',
      effectiveStatus: i === 0 ? 'ACTIVE' : 'PAUSED',
      campaignId,
      dailyBudget: (5 + i * 3) * 100,
      optimizationGoal: goals[i % goals.length],
      billingEvent: 'IMPRESSIONS',
      startTime: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(),
      updatedTime: new Date().toISOString(),
    });
    parentChain.set(id, {
      ...(parent?.actId ? { actId: parent.actId } : {}),
      campaignId,
    });
  }
  adsetsByCampaign.set(campaignId, list);
  return list;
}

// ===== Ad =====
function ensureAds(adsetId: string): MetaAd[] {
  let list = adsByAdset.get(adsetId);
  if (list) return list;
  const parent = parentChain.get(adsetId);
  list = [];
  const n = 2 + (fnv1a(adsetId) % 3); // 2..4
  for (let i = 0; i < n; i++) {
    const id = `mock_ad_${adsetId}_${i}`;
    list.push({
      id,
      name: `Ad ${i} of ${adsetId.slice(-6)}`,
      status: i % 2 === 0 ? 'ACTIVE' : 'PAUSED',
      effectiveStatus: i % 2 === 0 ? 'ACTIVE' : 'PAUSED',
      adsetId,
      ...(parent?.campaignId ? { campaignId: parent.campaignId } : {}),
      creativeId: `mock_creative_${id}`,
      updatedTime: new Date().toISOString(),
    });
    parentChain.set(id, {
      ...(parent?.actId ? { actId: parent.actId } : {}),
      ...(parent?.campaignId ? { campaignId: parent.campaignId } : {}),
      adsetId,
    });
  }
  adsByAdset.set(adsetId, list);
  return list;
}

// ===== Lookup helpers =====
function findCampaign(id: string): { list: MetaCampaign[]; idx: number } | null {
  for (const list of campaignsByActId.values()) {
    const idx = list.findIndex((c) => c.id === id);
    if (idx >= 0) return { list, idx };
  }
  return null;
}
function findAdSet(id: string): { list: MetaAdSet[]; idx: number } | null {
  for (const list of adsetsByCampaign.values()) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) return { list, idx };
  }
  return null;
}
function findAd(id: string): { list: MetaAd[]; idx: number } | null {
  for (const list of adsByAdset.values()) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) return { list, idx };
  }
  return null;
}

function applyRename(originalName: string, opts?: RenameOptions): string {
  if (!opts) return `Copy of ${originalName}`;
  const prefix = opts.rename_prefix ?? '';
  const suffix = opts.rename_suffix ?? '';
  if (opts.rename_strategy === 'NO_RENAME') return originalName;
  if (!prefix && !suffix) return `Copy of ${originalName}`;
  return `${prefix}${originalName}${suffix}`;
}

// ===== Insights mock =====
const DATE_MULT: Record<DatePreset, number> = {
  today: 0.5,
  yesterday: 1,
  last_7d: 7,
  last_30d: 30,
  maximum: 120,
};

function fakeInsightsFor(objectId: string, preset: DatePreset): InsightsSummary {
  const seed = fnv1a(objectId);
  // JS >> 是 sign-preserving; 用 >>> 保证无符号
  const baseSpendDaily = 5 + (seed % 4500) / 100; // 5.00..50.00
  const baseImprDaily = 1000 + (seed % 19000);
  const baseClickRate = 0.015 + ((seed >>> 4) % 50) / 1000; // 1.5%..6.5%
  const cvr = 0.01 + ((seed >>> 8) % 30) / 1000; // 1%..4%
  const mult = DATE_MULT[preset] ?? 7;

  const spend = Math.round(baseSpendDaily * mult * 100) / 100;
  const impressions = Math.round(baseImprDaily * mult);
  const clicks = Math.round(impressions * baseClickRate);
  const orders = Math.round(clicks * cvr);
  const addToCart = Math.round(orders * (2 + (seed % 3)));
  const checkout = Math.round(orders * (1.2 + ((seed >> 12) % 8) / 10));

  return {
    spend,
    impressions,
    clicks,
    cpc: clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : 0,
    cpm: impressions > 0 ? Math.round((spend / impressions) * 1000 * 100) / 100 : 0,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0, // %
    orders,
    cpa: orders > 0 ? Math.round((spend / orders) * 100) / 100 : 0,
    addToCart,
    initiateCheckout: checkout,
  };
}

// ===== 对外 fakeMeta =====
export const fakeMeta = {
  listCampaigns(metaActId: string): MetaCampaign[] {
    return [...ensureCampaigns(metaActId)];
  },

  listAdSets(campaignId: string): MetaAdSet[] {
    // 确保 campaign 已加载到内存中(便于 lookup parent chain)
    return [...ensureAdSets(campaignId)];
  },

  listAds(adsetId: string): MetaAd[] {
    return [...ensureAds(adsetId)];
  },

  setStatus(objectId: string, status: EntityStatus): void {
    const camp = findCampaign(objectId);
    if (camp) {
      const c = camp.list[camp.idx]!;
      c.status = status;
      c.effectiveStatus = status;
      c.updatedTime = new Date().toISOString();
      return;
    }
    const ad = findAdSet(objectId);
    if (ad) {
      const a = ad.list[ad.idx]!;
      a.status = status;
      a.effectiveStatus = status;
      a.updatedTime = new Date().toISOString();
      return;
    }
    const x = findAd(objectId);
    if (x) {
      const a = x.list[x.idx]!;
      a.status = status;
      a.effectiveStatus = status;
      a.updatedTime = new Date().toISOString();
    }
  },

  setBudget(objectId: string, daily?: number, lifetime?: number): void {
    const camp = findCampaign(objectId);
    if (camp) {
      const c = camp.list[camp.idx]!;
      if (daily !== undefined) c.dailyBudget = daily;
      if (lifetime !== undefined) c.lifetimeBudget = lifetime;
      c.updatedTime = new Date().toISOString();
      return;
    }
    const ad = findAdSet(objectId);
    if (ad) {
      const a = ad.list[ad.idx]!;
      if (daily !== undefined) a.dailyBudget = daily;
      if (lifetime !== undefined) a.lifetimeBudget = lifetime;
      a.updatedTime = new Date().toISOString();
    }
  },

  copyCampaign(campaignId: string, rename?: RenameOptions): string {
    const r = findCampaign(campaignId);
    if (!r) {
      const firstAct = campaignsByActId.keys().next().value as string | undefined;
      const newId = `mock_copy_${campaignId}_${Date.now()}`;
      if (firstAct) {
        const list = ensureCampaigns(firstAct);
        list.push({
          id: newId,
          name: applyRename(campaignId, rename),
          status: 'PAUSED',
          effectiveStatus: 'PAUSED',
          dailyBudget: 1000,
          updatedTime: new Date().toISOString(),
        });
        parentChain.set(newId, { actId: firstAct });
      }
      return newId;
    }
    const src = r.list[r.idx]!;
    const newId = `mock_copy_${src.id}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
    const parent = parentChain.get(src.id);
    r.list.push({
      ...src,
      id: newId,
      name: applyRename(src.name, rename),
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      updatedTime: new Date().toISOString(),
    });
    if (parent) parentChain.set(newId, parent);
    return newId;
  },

  copyAdSet(adsetId: string, rename?: RenameOptions): string {
    const r = findAdSet(adsetId);
    if (!r) return `mock_copy_${adsetId}_${Date.now()}`;
    const src = r.list[r.idx]!;
    const newId = `mock_copy_${src.id}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
    const parent = parentChain.get(src.id);
    r.list.push({
      ...src,
      id: newId,
      name: applyRename(src.name, rename),
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      updatedTime: new Date().toISOString(),
    });
    if (parent) parentChain.set(newId, parent);
    return newId;
  },

  copyAd(adId: string, rename?: RenameOptions): string {
    const r = findAd(adId);
    if (!r) return `mock_copy_${adId}_${Date.now()}`;
    const src = r.list[r.idx]!;
    const newId = `mock_copy_${src.id}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
    const parent = parentChain.get(src.id);
    r.list.push({
      ...src,
      id: newId,
      name: applyRename(src.name, rename),
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      updatedTime: new Date().toISOString(),
    });
    if (parent) parentChain.set(newId, parent);
    return newId;
  },

  remove(objectId: string, hard: boolean): void {
    const c = findCampaign(objectId);
    if (c) {
      if (hard) c.list.splice(c.idx, 1);
      else {
        const x = c.list[c.idx]!;
        x.status = 'ARCHIVED';
        x.effectiveStatus = 'ARCHIVED';
      }
      return;
    }
    const a = findAdSet(objectId);
    if (a) {
      if (hard) a.list.splice(a.idx, 1);
      else {
        const x = a.list[a.idx]!;
        x.status = 'ARCHIVED';
        x.effectiveStatus = 'ARCHIVED';
      }
      return;
    }
    const d = findAd(objectId);
    if (d) {
      if (hard) d.list.splice(d.idx, 1);
      else {
        const x = d.list[d.idx]!;
        x.status = 'ARCHIVED';
        x.effectiveStatus = 'ARCHIVED';
      }
    }
  },

  getInsights(objectId: string, preset: DatePreset): InsightsSummary {
    return fakeInsightsFor(objectId, preset);
  },

  getInsightsByChild(
    metaActId: string,
    level: 'campaign' | 'adset' | 'ad',
    preset: DatePreset,
  ): Record<string, InsightsSummary> {
    const out: Record<string, InsightsSummary> = {};
    const camps = ensureCampaigns(metaActId);
    if (level === 'campaign') {
      for (const c of camps) out[c.id] = fakeInsightsFor(c.id, preset);
      return out;
    }
    if (level === 'adset') {
      for (const c of camps) {
        for (const s of ensureAdSets(c.id)) out[s.id] = fakeInsightsFor(s.id, preset);
      }
      return out;
    }
    // ad
    for (const c of camps) {
      for (const s of ensureAdSets(c.id)) {
        for (const a of ensureAds(s.id)) out[a.id] = fakeInsightsFor(a.id, preset);
      }
    }
    return out;
  },

  getParent(objectId: string): { actId?: string; campaignId?: string; adsetId?: string } {
    const parent = parentChain.get(objectId) ?? inferParent(objectId);
    if (parent.actId || parent.campaignId || parent.adsetId) {
      parentChain.set(objectId, parent);
    }
    return parent;
  },
};
