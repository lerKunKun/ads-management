/**
 * 告警通道:
 *   - console (默认): 日志输出
 *   - feishu  : 飞书自定义机器人 Webhook (interactive card)
 *
 * 当前用户决定: MVP 暂不接入飞书,driver 保持 console。
 * 切换: env.notifierDriver='feishu' + FEISHU_WEBHOOK_URL=... 即可启用。
 *
 * 调用方:
 *   - account.service.scanTokenHealth   token 即将过期/已失效
 *   - worker.handler                    Meta token 失效熔断时
 *   - operation.service                 同上
 */
import { env } from '../env';

export type Level = 'info' | 'warn' | 'error';

export interface Notifier {
  notify(level: Level, title: string, detail?: Record<string, unknown>): Promise<void>;
}

class ConsoleNotifier implements Notifier {
  async notify(level: Level, title: string, detail?: Record<string, unknown>) {
    const ts = new Date().toISOString();
    const line = `[notifier:${level}] ${ts} ${title} ${detail ? JSON.stringify(detail) : ''}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

class FeishuNotifier implements Notifier {
  constructor(private webhookUrl: string) {}

  async notify(level: Level, title: string, detail?: Record<string, unknown>) {
    const color =
      level === 'error' ? 'red' : level === 'warn' ? 'orange' : 'blue';
    const lines: string[] = [];
    if (detail) {
      for (const [k, v] of Object.entries(detail)) {
        lines.push(`**${k}**: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      }
    }
    const card = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: color,
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: lines.join('\n') || '(no detail)',
            },
          },
        ],
      },
    };
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(card),
      });
      if (!res.ok) {
        console.error(`[notifier:feishu] HTTP ${res.status}`);
      }
    } catch (e) {
      console.error('[notifier:feishu] failed', e);
    }
  }
}

function pickDriver(): Notifier {
  if (env.notifierDriver === 'feishu') {
    if (!env.feishuWebhookUrl) {
      console.warn('[notifier] driver=feishu but FEISHU_WEBHOOK_URL missing; falling back to console');
      return new ConsoleNotifier();
    }
    return new FeishuNotifier(env.feishuWebhookUrl);
  }
  return new ConsoleNotifier();
}

export const notifier: Notifier = pickDriver();
