export const PERMISSIONS = {
  AD_ACCOUNT_READ: 'ad_account:read',
  CAMPAIGN_STATUS: 'campaign:status',
  CAMPAIGN_BUDGET: 'campaign:budget',
  CAMPAIGN_COPY: 'campaign:copy',
  CAMPAIGN_DELETE: 'campaign:delete',
  IAM_MANAGE: 'iam:manage',
  FB_ACCOUNT_BIND: 'fb_account:bind',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLES = {
  PLATFORM_ADMIN: 'PlatformAdmin',
  COMPANY_ADMIN: 'CompanyAdmin',
  OPERATOR: 'Operator',
  VIEWER: 'Viewer',
} as const;

export type RoleCode = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_PERMISSIONS: Record<RoleCode, PermissionCode[]> = {
  PlatformAdmin: Object.values(PERMISSIONS),
  CompanyAdmin: [
    PERMISSIONS.AD_ACCOUNT_READ,
    PERMISSIONS.CAMPAIGN_STATUS,
    PERMISSIONS.CAMPAIGN_BUDGET,
    PERMISSIONS.CAMPAIGN_COPY,
    PERMISSIONS.CAMPAIGN_DELETE,
    PERMISSIONS.IAM_MANAGE,
    PERMISSIONS.FB_ACCOUNT_BIND,
  ],
  Operator: [
    PERMISSIONS.AD_ACCOUNT_READ,
    PERMISSIONS.CAMPAIGN_STATUS,
    PERMISSIONS.CAMPAIGN_BUDGET,
    PERMISSIONS.CAMPAIGN_COPY,
    PERMISSIONS.CAMPAIGN_DELETE,
  ],
  Viewer: [PERMISSIONS.AD_ACCOUNT_READ],
};

export const SCOPE_BYPASS_ROLES: ReadonlySet<RoleCode> = new Set([
  ROLES.PLATFORM_ADMIN,
  ROLES.COMPANY_ADMIN,
]);
