/**
 * 集中处理 env，启动期 fail-fast。
 */
function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

function opt(key: string, def: string): string {
  return process.env[key] ?? def;
}

export const env = {
  nodeEnv: opt('NODE_ENV', 'development'),
  apiPort: Number(opt('API_PORT', '3001')),

  databaseUrl: opt('DATABASE_URL', 'postgres://ads_app:ads_app@localhost:5432/ads'),
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),
  rabbitmqUrl: opt('RABBITMQ_URL', 'amqp://ads:ads@localhost:5672'),

  jwtSecret: opt('JWT_SECRET', 'dev-only-replace-me'),
  jwtExpiresIn: opt('JWT_EXPIRES_IN', '12h'),

  /** 32 字节, base64. 缺省时启动会拒绝(prod) / 临时生成(dev) */
  tokenEncKey: process.env['TOKEN_ENC_KEY'] ?? '',

  crmBaseUrl: opt('CRM_BASE_URL', 'https://adtool-api.gimc-hk.com'),
  crmCid: opt('CRM_CID', ''),
  crmAccessToken: opt('CRM_ACCESS_TOKEN', ''),

  metaApiVersion: opt('META_API_VERSION', 'v21.0'),
  metaGraphBase: opt('META_GRAPH_BASE', 'https://graph.facebook.com'),

  fbOauthRedirectUri: opt('FB_OAUTH_REDIRECT_URI', 'http://localhost:5173/oauth/fb/callback'),

  notifierDriver: opt('NOTIFIER_DRIVER', 'console') as 'console' | 'feishu',
  feishuWebhookUrl: opt('FEISHU_WEBHOOK_URL', ''),
};

export type Env = typeof env;
export { need };
