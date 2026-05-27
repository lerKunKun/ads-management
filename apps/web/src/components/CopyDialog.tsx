import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import type { CopyParams } from '@/lib/api';

export interface CopySourceSnapshot {
  id: string;
  name: string;
  startTime?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

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
  currency?: string | null;
  sources?: CopySourceSnapshot[];
}

/**
 * 复制对话框 - 支持:
 *   排期起始时间(默认继承原对象)
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
  currency,
  sources = [],
}: CopyDialogProps) {
  const defaults = useMemo(
    () => summarizeSources(sources, layer, adAccountTimezone, currency),
    [adAccountTimezone, currency, layer, sources],
  );
  const [startTime, setStartTime] = useState('');
  const [modifySchedule, setModifySchedule] = useState(false);
  const [modifyBudget, setModifyBudget] = useState(false);
  const [budgetKind, setBudgetKind] = useState<'dailyBudget' | 'lifetimeBudget'>('dailyBudget');
  const [budgetValue, setBudgetValue] = useState('');
  const [count, setCount] = useState(1);
  const [prefix, setPrefix] = useState('');
  const [dateSuffix, setDateSuffix] = useState(false);
  const [country, setCountry] = useState('');
  const [testIdx, setTestIdx] = useState('');
  const [deepCopy, setDeepCopy] = useState(true);
  const [pauseAfter, setPauseAfter] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStartTime(defaults.startInput);
    setModifySchedule(false);
    setModifyBudget(false);
    setBudgetKind(defaults.budgetKind ?? 'dailyBudget');
    setBudgetValue(defaults.budgetValue);
    setCount(1);
    setPrefix('');
    setDateSuffix(false);
    setCountry('');
    setTestIdx('');
    setDeepCopy(true);
    setPauseAfter(false);
  }, [defaults.budgetKind, defaults.budgetValue, defaults.startInput, open]);

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
    try {
      resolvedStartTime = modifySchedule ? localInputToIso(startTime, adAccountTimezone) : undefined;
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      return;
    }
    const budgetPatch: Pick<CopyParams, 'dailyBudget' | 'lifetimeBudget'> = {};
    if (modifyBudget) {
      const budgetMajor = Number(budgetValue);
      if (!Number.isFinite(budgetMajor) || budgetMajor <= 0) {
        alert('预算必须大于 0');
        return;
      }
      const budgetMinor = Math.round(budgetMajor * 100);
      if (budgetKind === 'dailyBudget') budgetPatch.dailyBudget = budgetMinor;
      else budgetPatch.lifetimeBudget = budgetMinor;
    }
    const suffix = buildSuffix();
    const params: CopyParams = {
      count,
      ...(resolvedStartTime ? { startTime: resolvedStartTime } : {}),
      ...budgetPatch,
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
      {hint && <p className="mb-2 break-words text-xs text-muted-foreground">{hint}</p>}

      <div className="space-y-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm text-muted-foreground">起始时间</label>
            {layer !== 'ad' && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={modifySchedule}
                  onChange={(e) => {
                    setModifySchedule(e.target.checked);
                    if (e.target.checked && !startTime) setStartTime(defaults.startInput);
                  }}
                />
                修改起始时间
              </label>
            )}
          </div>
          <Input
            type={modifySchedule ? 'datetime-local' : 'text'}
            value={modifySchedule ? startTime : defaults.startLabel}
            disabled={!modifySchedule}
            onChange={(e) => setStartTime(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            默认继承原对象排期；填写时按广告账户时区 {timezoneLabel} 提交。
          </p>
        </div>

        {layer !== 'ad' && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-sm text-muted-foreground">预算</label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={modifyBudget}
                  onChange={(e) => {
                    setModifyBudget(e.target.checked);
                    if (e.target.checked && !budgetValue) setBudgetValue(defaults.budgetValue);
                  }}
                />
                修改预算
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                value={budgetKind}
                disabled={!modifyBudget}
                onChange={(e) => setBudgetKind(e.target.value as 'dailyBudget' | 'lifetimeBudget')}
              >
                <option value="dailyBudget">日预算</option>
                <option value="lifetimeBudget">总预算</option>
              </select>
              <Input
                type={modifyBudget ? 'number' : 'text'}
                min={0}
                step="0.01"
                value={modifyBudget ? budgetValue : defaults.budgetLabel}
                disabled={!modifyBudget}
                onChange={(e) => setBudgetValue(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              默认继承原对象预算和其他设置；勾选后对本次复制统一覆盖预算。
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

        <div className="grid gap-3 sm:grid-cols-2">
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

        <div className="grid gap-3 sm:grid-cols-2">
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

        <div className="flex flex-wrap items-center gap-3 pt-1">
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
          <span className="break-all font-mono">
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

function summarizeSources(
  sources: CopySourceSnapshot[],
  layer: CopyDialogProps['layer'],
  timeZone: string | null | undefined,
  currency: string | null | undefined,
): {
  startInput: string;
  startLabel: string;
  budgetKind?: 'dailyBudget' | 'lifetimeBudget';
  budgetValue: string;
  budgetLabel: string;
} {
  const startSummary = sameValue(sources.map((source) => source.startTime));
  const startInput = startSummary.value ? isoToZonedInput(startSummary.value, timeZone) : '';
  const startLabel = startSummary.mixed
    ? '多个不同排期，默认分别继承'
    : startInput || '未设置';

  if (layer === 'ad') {
    return {
      startInput,
      startLabel,
      budgetValue: '',
      budgetLabel: '广告无独立预算',
    };
  }

  const budgetSummary = sameBudget(sources);
  if (budgetSummary.mixed) {
    return {
      startInput,
      startLabel,
      budgetKind: 'dailyBudget',
      budgetValue: '',
      budgetLabel: '多个不同预算，默认分别继承',
    };
  }
  if (!budgetSummary.kind || budgetSummary.value === undefined) {
    return {
      startInput,
      startLabel,
      budgetKind: 'dailyBudget',
      budgetValue: '',
      budgetLabel: '未设置',
    };
  }
  const budgetValue = (budgetSummary.value / 100).toFixed(2);
  return {
    startInput,
    startLabel,
    budgetKind: budgetSummary.kind,
    budgetValue,
    budgetLabel: `${budgetValue}${currency ? ` ${currency}` : ''}`,
  };
}

function sameValue(values: Array<string | undefined>): { value?: string; mixed: boolean } {
  const normalized = values.map((value) => value ?? '');
  const first = normalized[0] ?? '';
  return {
    ...(first ? { value: first } : {}),
    mixed: normalized.some((value) => value !== first),
  };
}

function sameBudget(sources: CopySourceSnapshot[]): {
  kind?: 'dailyBudget' | 'lifetimeBudget';
  value?: number;
  mixed: boolean;
} {
  const values = sources.map((source) => {
    if (source.dailyBudget !== undefined) return { kind: 'dailyBudget' as const, value: source.dailyBudget };
    if (source.lifetimeBudget !== undefined) return { kind: 'lifetimeBudget' as const, value: source.lifetimeBudget };
    return { kind: undefined, value: undefined };
  });
  const first = values[0] ?? { kind: undefined, value: undefined };
  return {
    ...(first.kind ? { kind: first.kind } : {}),
    ...(first.value !== undefined ? { value: first.value } : {}),
    mixed: values.some((item) => item.kind !== first.kind || item.value !== first.value),
  };
}

function isoToZonedInput(value: string, timeZone: string | null | undefined): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  if (!timeZone) return '';
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    return '';
  }
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  if (!values.year || !values.month || !values.day || !values.hour || !values.minute) return '';
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
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
