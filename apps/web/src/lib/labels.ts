export const ACCOUNT_GROUP_LABEL = 'FB个人号';

const ACCOUNT_GROUP_STATUS: Record<string, string> = {
  active: '正常',
  token_invalid: 'Token 异常',
  disabled: '已停用',
};

const AD_ACCOUNT_STATUS: Record<string, string> = {
  active: '正常',
  pending: '待同步',
  disabled: '已停用',
  closed: '已关闭',
};

const USER_STATUS: Record<string, string> = {
  active: '正常',
  disabled: '已停用',
};

const COMPANY_STATUS = USER_STATUS;

const TASK_STATUS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
  paused: '已暂停',
  partial: '部分成功',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

const META_ENTITY_STATUS: Record<string, string> = {
  ACTIVE: '启用',
  PAUSED: '暂停',
  ARCHIVED: '已归档',
  DELETED: '已删除',
};

const META_EFFECTIVE_STATUS: Record<string, string> = {
  ACTIVE: '投放中',
  PAUSED: '已暂停',
  ARCHIVED: '已归档',
  DELETED: '已删除',
  IN_PROCESS: '处理中',
  WITH_ISSUES: '广告错误',
  NO_ADS: '无广告',
  ADSET_HAS_NO_ADS: '无广告',
  ADSET_HAS_NO_ACTIVE_ADS: '无投放广告',
  CAMPAIGN_HAS_NO_ADS: '无广告',
  CAMPAIGN_HAS_NO_ADSETS: '无广告组',
  CAMPAIGN_HAS_NO_ACTIVE_ADSETS: '无投放广告组',
  AD_HAS_NO_CREATIVE: '无创意',
  PENDING_REVIEW: '审核中',
  DISAPPROVED: '审核未通过',
  PREAPPROVED: '预审核通过',
  PENDING_BILLING_INFO: '等待账单信息',
  CAMPAIGN_PAUSED: '广告系列已暂停',
  CAMPAIGN_GROUP_PAUSED: '广告系列已暂停',
  ADSET_PAUSED: '广告组已暂停',
  AD_PAUSED: '广告已暂停',
};

const BREAKER_KIND: Record<string, string> = {
  fb: ACCOUNT_GROUP_LABEL,
  adacct: '广告账户',
};

export function accountGroupStatusLabel(status: string | null | undefined): string {
  return labelFrom(ACCOUNT_GROUP_STATUS, status);
}

export function adAccountStatusLabel(status: string | null | undefined): string {
  return labelFrom(AD_ACCOUNT_STATUS, status);
}

export function userStatusLabel(status: string | null | undefined): string {
  return labelFrom(USER_STATUS, status);
}

export function companyStatusLabel(status: string | null | undefined): string {
  return labelFrom(COMPANY_STATUS, status);
}

export function taskStatusLabel(status: string | null | undefined): string {
  return labelFrom(TASK_STATUS, status);
}

export function metaEntityStatusLabel(status: string | null | undefined): string {
  return labelFrom(META_ENTITY_STATUS, status);
}

export function metaEffectiveStatusLabel(status: string | null | undefined): string {
  return labelFrom(META_EFFECTIVE_STATUS, status);
}

export function breakerKindLabel(kind: string | null | undefined): string {
  return labelFrom(BREAKER_KIND, kind);
}

function labelFrom(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '-';
  return map[value] ?? value;
}
