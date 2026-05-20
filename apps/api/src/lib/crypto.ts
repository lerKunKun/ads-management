/**
 * AES-256-GCM 加密/解密 FB user token。
 * 输出格式: base64(iv || ciphertext || authTag)
 * dev: 若未配置 TOKEN_ENC_KEY，生成进程级 ephemeral key（重启后旧 token 解不出）
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env';

const KEY: Buffer = (() => {
  if (env.tokenEncKey) {
    const k = Buffer.from(env.tokenEncKey, 'base64');
    if (k.length !== 32) {
      throw new Error('TOKEN_ENC_KEY must be 32 bytes (base64).');
    }
    return k;
  }
  if (env.nodeEnv === 'production') {
    throw new Error('TOKEN_ENC_KEY required in production.');
  }
  console.warn('[crypto] TOKEN_ENC_KEY missing — using ephemeral dev key');
  return randomBytes(32);
})();

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

export function decryptToken(enc: string): string {
  const buf = Buffer.from(enc, 'base64');
  if (buf.length < 12 + 16) throw new Error('invalid ciphertext');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
