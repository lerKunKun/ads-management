/**
 * 广告平台 Provider 接口。MVP 只实现 MetaProvider;TikTok/Google 后续。
 * 三层抽象: campaign / adset / ad,字面量通过 targetType 区分。
 */
export type CampaignStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';

export type TargetType = 'campaign' | 'adset' | 'ad';

export interface SetStatusInput {
  adAccountId: string;
  targetId: string;
  targetType: TargetType;
  status: CampaignStatus;
}

export interface SetBudgetInput {
  adAccountId: string;
  targetId: string;
  targetType: 'campaign' | 'adset';
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export interface RenameOptions {
  rename_strategy?: 'DEEP_COPY_RENAME' | 'NO_RENAME' | 'ONLY_TOP_LEVEL_RENAME';
  rename_prefix?: string;
  rename_suffix?: string;
}

export interface CopyInput {
  adAccountId: string;
  /** 来源 id (campaign/adset/ad) */
  sourceId: string;
  targetType: TargetType;
  /** 仅 campaign 跨账户复制时用 (MVP 必须等于 adAccountId) */
  targetAdAccountId?: string;
  /** 仅 adset 复制到目标 campaign 用 */
  targetCampaignId?: string;
  /** 仅 ad 复制到目标 adset 用 */
  targetAdSetId?: string;
  deepCopy?: boolean;
  startTime?: string;
  endTime?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  statusOption?: 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE';
  renameOptions?: RenameOptions;
}

export interface DeleteInput {
  adAccountId: string;
  targetId: string;
  targetType: TargetType;
  hard?: boolean;
}

export interface AdsProvider {
  readonly name: 'meta' | 'tiktok' | 'google';
  setStatus(token: string, input: SetStatusInput): Promise<void>;
  setBudget(token: string, input: SetBudgetInput): Promise<void>;
  copy(token: string, input: CopyInput): Promise<{ newId: string }>;
  remove(token: string, input: DeleteInput): Promise<void>;
}
