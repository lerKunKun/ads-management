/**
 * CRM 对外 API 客户端 (全局单一凭证, 不入库)。
 *   - 接口 1: GET /api/custom/security/accounts/meta/oauth/authorize-url?redirect_uri=...
 *   - 接口 2: POST /api/custom/security/accounts/meta/oauth/access-token  { redirect_uri, code }
 * Headers:  cid (全小写)  + accessToken (camelCase) — 与 CRM 文档严格一致。
 *
 * 响应统一: { code: 0, msg: "操作成功", data: ... }
 * 非 0 code 视作业务错误，msg 原样透传 (CRM 用中文 msg)。
 */
import { env } from '../env';
import { HttpError } from './http-error';

interface CrmEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  if (!env.crmCid || !env.crmAccessToken) {
    throw new HttpError(500, 1001, 'CRM_CID / CRM_ACCESS_TOKEN 未配置');
  }
  const url = new URL(path, env.crmBaseUrl);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  }

  // GET 不带 content-type;POST 才带。headers key 大小写与文档严格一致。
  const headers: Record<string, string> = {
    cid: env.crmCid,
    accessToken: env.crmAccessToken,
  };
  if (init.method !== 'GET' && init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  // 网络/HTTP 层错误 (与业务 code 区分)
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.warn('[crm:http-error]', {
      path,
      status: res.status,
      body: txt.slice(0, 500),
    });
    throw new HttpError(
      res.status === 401 || res.status === 403 ? res.status : 502,
      1001,
      `CRM ${path} HTTP ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`,
    );
  }

  let json: CrmEnvelope<T>;
  try {
    json = (await res.json()) as CrmEnvelope<T>;
  } catch {
    throw new HttpError(502, 1001, `CRM ${path}: 响应非 JSON`);
  }

  if (json.code !== 0) {
    console.warn('[crm:business-error]', {
      path,
      code: json.code,
      message: json.msg,
    });
    // 业务失败,把 CRM 的 msg 原样透传 (中文)
    throw new HttpError(400, 1001, json.msg ?? `CRM ${path} 业务失败 (code=${json.code})`);
  }
  return json.data;
}

export const crm = {
  /** 接口 1: 取授权链接(代理) */
  async authorizeUrl(redirectUri: string): Promise<{ authorize_url: string }> {
    return call('/api/custom/security/accounts/meta/oauth/authorize-url', {
      method: 'GET',
      query: { redirect_uri: redirectUri },
    });
  },

  /** 接口 2: 用 code 换 user-level long-lived access_token (~60d) */
  async exchangeToken(
    redirectUri: string,
    code: string,
  ): Promise<{ access_token: string; token_type?: string; expires_in?: number }> {
    return call('/api/custom/security/accounts/meta/oauth/access-token', {
      method: 'POST',
      body: { redirect_uri: redirectUri, code },
    });
  },
};
