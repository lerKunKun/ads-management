export const ACCOUNT_GROUP_LABEL = '广告账户组';

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

const TASK_STATUS: Record<string, string> = {
  pending: '等待中',
  running: '运行中',
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

export function taskStatusLabel(status: string | null | undefined): string {
  return labelFrom(TASK_STATUS, status);
}

export function metaEntityStatusLabel(status: string | null | undefined): string {
  return labelFrom(META_ENTITY_STATUS, status);
}

export function breakerKindLabel(kind: string | null | undefined): string {
  return labelFrom(BREAKER_KIND, kind);
}

function labelFrom(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '-';
  return map[value] ?? value;
}
