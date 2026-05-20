/**
 * 极简 HS256 JWT (签发 + 校验)。不引第三方库，便于 Bun 直接跑。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

interface BasePayload {
  sub: string;        // user_id
  cid: string;        // company_id
  iat: number;
  exp: number;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) return Number(s) || 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return n;
  }
}

export function sign(payload: { sub: string; cid: string }): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const full: BasePayload = {
    ...payload,
    iat: now,
    exp: now + parseDuration(env.jwtExpiresIn),
  };
  const body = b64url(JSON.stringify(full));
  const sig = b64url(
    createHmac('sha256', env.jwtSecret).update(`${header}.${body}`).digest(),
  );
  return `${header}.${body}.${sig}`;
}

export function verify(token: string): BasePayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  const expected = b64url(createHmac('sha256', env.jwtSecret).update(`${h}.${b}`).digest());
  const a = Buffer.from(s);
  const c = Buffer.from(expected);
  if (a.length !== c.length || !timingSafeEqual(a, c)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as BasePayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
