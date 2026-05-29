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
  metaAsyncCopyTimeoutMs: Number(opt('META_ASYNC_COPY_TIMEOUT_MS', '1800000')),
  adObjectCacheTtlMs: Number(opt('AD_OBJECT_CACHE_TTL_MS', '30000')),
  adObjectSyncEnabled: opt('AD_OBJECT_SYNC_ENABLED', '0') === '1',
  adObjectSyncIntervalMs: Number(opt('AD_OBJECT_SYNC_INTERVAL_MS', '300000')),
  adObjectSyncBatchSize: Number(opt('AD_OBJECT_SYNC_BATCH_SIZE', '2')),
  adObjectSyncDepth: opt('AD_OBJECT_SYNC_DEPTH', 'campaign') as 'campaign' | 'adset' | 'ad',
  adObjectSyncMaxCampaigns: Number(opt('AD_OBJECT_SYNC_MAX_CAMPAIGNS', '20')),
  adObjectSyncMaxAdsets: Number(opt('AD_OBJECT_SYNC_MAX_ADSETS', '50')),
  adObjectSyncStaleMs: Number(opt('AD_OBJECT_SYNC_STALE_MS', '900000')),

  copyV2JsonbEnabled: opt('COPY_V2_JSONB_ENABLED', '0') === '1',
  copyV2AccountAllowlist: opt('COPY_V2_ACCOUNT_ALLOWLIST', ''),
  copyV2MinAdCount: Number(opt('COPY_V2_MIN_AD_COUNT', '52')),
  copyV2MinAdsetCount: Number(opt('COPY_V2_MIN_ADSET_COUNT', '5')),
  copyV2AdsetConcurrency: Number(opt('COPY_V2_ADSET_CONCURRENCY', '2')),
  copyV2AdConcurrency: Number(opt('COPY_V2_AD_CONCURRENCY', '3')),
  copyV2GlobalQps: Number(opt('COPY_V2_GLOBAL_QPS', '27')),
  copyV2GlobalBurst: Number(opt('COPY_V2_GLOBAL_BURST', '100')),
  copyV2GlobalConcurrency: Number(opt('COPY_V2_GLOBAL_CONCURRENCY', '120')),
  copyV2GlobalLeaseTtlMs: Number(opt('COPY_V2_GLOBAL_LEASE_TTL_MS', '120000')),
  copyV2AdAccountQps: Number(opt('COPY_V2_AD_ACCOUNT_QPS', '6')),
  copyV2AdAccountBurst: Number(opt('COPY_V2_AD_ACCOUNT_BURST', '24')),
  copyV2InspectConcurrency: Number(opt('COPY_V2_INSPECT_CONCURRENCY', '32')),
  copyV2VerifyConcurrency: Number(opt('COPY_V2_VERIFY_CONCURRENCY', '32')),
  copyV2VerifyAttempts: Number(opt('COPY_V2_VERIFY_ATTEMPTS', '4')),
  copyV2VerifyRetryDelayMs: Number(opt('COPY_V2_VERIFY_RETRY_DELAY_MS', '10000')),
  copyV2DefaultStatus: opt('COPY_V2_DEFAULT_STATUS', 'PAUSED') as 'PAUSED',
  copyV2VerifyEnabled: opt('COPY_V2_VERIFY_ENABLED', '1') === '1',
  copyV2RepairEnabled: opt('COPY_V2_REPAIR_ENABLED', '1') === '1',
  copyBatchConcurrency: Number(opt('COPY_BATCH_CONCURRENCY', '16')),
  copyBatchCampaignConcurrency: Number(opt('COPY_BATCH_CAMPAIGN_CONCURRENCY', '2')),
  copyBatchAdsetConcurrency: Number(opt('COPY_BATCH_ADSET_CONCURRENCY', opt('COPY_BATCH_CONCURRENCY', '16'))),
  copyBatchAdConcurrency: Number(opt('COPY_BATCH_AD_CONCURRENCY', opt('COPY_BATCH_CONCURRENCY', '16'))),

  fbOauthRedirectUri: opt('FB_OAUTH_REDIRECT_URI', 'http://localhost:5173/oauth/fb/callback'),

  notifierDriver: opt('NOTIFIER_DRIVER', 'console') as 'console' | 'feishu',
  feishuWebhookUrl: opt('FEISHU_WEBHOOK_URL', ''),
};

export type Env = typeof env;
export { need };
