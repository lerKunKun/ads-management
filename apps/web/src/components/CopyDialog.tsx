import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import type { CopyParams } from '@/lib/api';

interface CopyDialogProps {
  open: boolean;
  layer: 'campaign' | 'adset' | 'ad';
  /** 显示给用户的源对象数(单选 1,批量 N) */
  targetCount: number;
  /** 单选时显示源名;批量时显示数字 */
  hint?: string;
  onCancel: () => void;
  onSubmit: (params: CopyParams) => void;
  submitting: boolean;
  adAccountTimezone?: string | null;
}

/**
 * 复制对话框 - 支持:
 *   排期起始/结束时间(默认继承原对象)
 *   复制条数 N(默认 1, 不设上限)
 *   自定义前缀
 *   日期后缀(可选,自动 yyyymmdd)
 *   国家后缀(自由输入)
 *   测试编号后缀(数字 padded 2 位,从 #1 开始 — N>1 时 worker 自动追加)
 */
export function CopyDialog({
  open,
  layer,
  targetCount,
  hint,
  onCancel,
  onSubmit,
  submitting,
  adAccountTimezone,
}: CopyDialogProps) {
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [count, setCount] = useState(1);
  const [prefix, setPrefix] = useState('');
  const [dateSuffix, setDateSuffix] = useState(false);
  const [country, setCountry] = useState('');
  const [testIdx, setTestIdx] = useState('');
  const [deepCopy, setDeepCopy] = useState(true);
  const [pauseAfter, setPauseAfter] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStartTime('');
    setEndTime('');
    setCount(1);
    setPrefix('');
    setDateSuffix(false);
    setCountry('');
    setTestIdx('');
    setDeepCopy(true);
    setPauseAfter(false);
  }, [open]);

  function buildSuffix(): string {
    const parts: string[] = [];
    if (dateSuffix) parts.push(formatYMD(new Date()));
    if (country) parts.push(country.toUpperCase());
    if (testIdx) parts.push(`T${testIdx}`);
    return parts.length ? '_' + parts.join('_') : '';
  }

  function handleSubmit() {
    if (!Number.isFinite(count) || count < 1) {
      alert('复制条数必须 ≥ 1');
      return;
    }
    let resolvedStartTime: string | undefined;
    let resolvedEndTime: string | undefined;
    try {
      resolvedStartTime = startTime ? localInputToIso(startTime, adAccountTimezone) : undefined;
      resolvedEndTime = endTime ? localInputToIso(endTime, adAccountTimezone) : undefined;
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      return;
    }
    if (
      resolvedStartTime &&
      resolvedEndTime &&
      Date.parse(resolvedEndTime) <= Date.parse(resolvedStartTime)
    ) {
      alert('结束时间必须晚于起始时间');
      return;
    }
    const suffix = buildSuffix();
    const params: CopyParams = {
      count,
      ...(resolvedStartTime ? { startTime: resolvedStartTime } : {}),
      ...(resolvedEndTime ? { endTime: resolvedEndTime } : {}),
      statusOption: pauseAfter ? 'PAUSED' : 'INHERITED_FROM_SOURCE',
      ...(layer !== 'ad' ? { deepCopy } : {}),
      ...((prefix || suffix)
        ? {
          renameOptions: {
            rename_strategy: 'ONLY_TOP_LEVEL_RENAME',
            ...(prefix ? { rename_prefix: prefix } : {}),
            ...(suffix ? { rename_suffix: suffix } : {}),
          },
        }
        : {}),
    };
    onSubmit(params);
  }

  const layerName =
    layer === 'campaign' ? '广告系列' : layer === 'adset' ? '广告组' : '广告';
  const timezoneLabel = adAccountTimezone ?? '账户时区加载中';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !submitting && onCancel()}
      title={`复制 ${layerName}${targetCount > 1 ? ` ×${targetCount}` : ''}`}
    >
      {hint && <p className="text-xs text-muted-foreground mb-2">{hint}</p>}

      <div className="space-y-3">
        {layer !== 'ad' && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="text-sm text-muted-foreground">起始时间</label>
              <Input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">结束时间</label>
              <Input
                type="datetime-local"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground md:col-span-2">
              留空保持原对象排期；填写时按广告账户时区 {timezoneLabel} 提交。
            </p>
          </div>
        )}

        <div>
          <label className="text-sm text-muted-foreground">每个源复制 N 份</label>
          <Input
            type="number"
            min={1}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
          />
          {count > 1 && (
            <p className="text-xs text-muted-foreground mt-1">
              N 份会自动加 -01 / -02 / … 后缀,避免名字冲突。共产生{' '}
              <b>{targetCount * count}</b> 个新{layerName}。
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-muted-foreground">前缀</label>
            <Input
              placeholder="如 ABTest_"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground">国家后缀</label>
            <Input
              placeholder="US / SEA"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
              <input
                type="checkbox"
                checked={dateSuffix}
                onChange={(e) => setDateSuffix(e.target.checked)}
              />
              日期后缀 ({formatYMD(new Date())})
            </label>
          </div>
          <div>
            <label className="text-sm text-muted-foreground">测试编号</label>
            <Input
              placeholder="如 v1"
              value={testIdx}
              onChange={(e) => setTestIdx(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-4 pt-1">
          {layer !== 'ad' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deepCopy}
                onChange={(e) => setDeepCopy(e.target.checked)}
              />
              深复制（含下级）
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pauseAfter}
              onChange={(e) => setPauseAfter(e.target.checked)}
            />
            复制后保持暂停
          </label>
        </div>

        <div className="rounded-md bg-muted/50 p-2 text-xs">
          <span className="text-muted-foreground">预览名:</span>{' '}
          <span className="font-mono">
            {prefix || ''}
            <span className="text-muted-foreground">{`{原${layerName}名}`}</span>
            {buildSuffix()}
            {count > 1 ? <span className="text-emerald-600">-01..-{String(count).padStart(2, '0')}</span> : ''}
          </span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? '提交中…' : '开始复制'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function formatYMD(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function localInputToIso(s: string, timeZone: string | null | undefined): string {
  const parsed = parseDateTimeLocal(s);
  if (!parsed) throw new Error('排期时间格式无效');
  if (!timeZone) throw new Error('广告账户时区未加载，不能设置排期时间');

  const utcGuess = Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, 0, 0);
  let utcTime = utcGuess - timeZoneOffsetMs(new Date(utcGuess), timeZone);
  for (let i = 0; i < 3; i++) {
    const next = utcGuess - timeZoneOffsetMs(new Date(utcTime), timeZone);
    if (Math.abs(next - utcTime) < 1) break;
    utcTime = next;
  }
  return new Date(utcTime).toISOString();
}

function parseDateTimeLocal(value: string):
  | { year: number; month: number; day: number; hour: number; minute: number }
  | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    throw new Error(`广告账户时区无效：${timeZone}`);
  }
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const year = values.year;
  const month = values.month;
  const day = values.day;
  const hour = values.hour;
  const minute = values.minute;
  const second = values.second;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new Error(`广告账户时区无法解析：${timeZone}`);
  }
  const zonedAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
  );
  return zonedAsUtc - date.getTime();
}
