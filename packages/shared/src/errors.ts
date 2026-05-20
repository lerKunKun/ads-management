/** 统一错误结构，对齐 CRM 风格 { code, msg, data } */
export interface ApiError {
  code: number;
  msg: string;
  data?: unknown;
}

export const ERR = {
  OK: 0,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  INTERNAL: 500,
  CRM_FAILED: 1001,
  META_FAILED: 1002,
  TOKEN_INVALID: 1003,
  TOKEN_EXPIRED: 1004,
} as const;
