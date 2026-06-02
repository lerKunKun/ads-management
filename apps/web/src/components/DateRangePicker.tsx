import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DatePreset } from '@/lib/api';

type DateMode = DatePreset | 'custom';

export interface DateRangePickerValue {
  mode: DateMode;
  since: string;
  until: string;
}

interface DateRangePickerProps {
  value: DateRangePickerValue;
  onChange: (value: DateRangePickerValue) => void;
  className?: string;
}

const QUICK_RANGES: Array<{ mode: DateMode; label: string }> = [
  { mode: 'today', label: '今天' },
  { mode: 'yesterday', label: '昨天' },
  { mode: 'last_7d', label: '近 7 天' },
  { mode: 'last_30d', label: '近 30 天' },
  { mode: 'maximum', label: '全部' },
  { mode: 'custom', label: '自定义范围' },
];

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MS_PER_DAY = 86400000;

export function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRangePickerValue>(value);
  const [leftMonth, setLeftMonth] = useState(() => monthStart(dateFromKey(value.since)));
  const [panelPosition, setPanelPosition] = useState({ top: 72, left: 12, width: 720 });

  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setLeftMonth(monthStart(dateFromKey(value.since)));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 12;
      const width = Math.min(720, window.innerWidth - margin * 2);
      const left = Math.min(
        Math.max(margin, rect.right - width),
        window.innerWidth - width - margin,
      );
      setPanelPosition({ top: rect.bottom + 8, left, width });
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const rightMonth = useMemo(() => addMonths(leftMonth, 1), [leftMonth]);
  const canApply = draft.mode !== 'custom' || (!!draft.since && !!draft.until);

  function pickQuick(mode: DateMode) {
    if (mode === 'custom') {
      setDraft((current) => ({ ...current, mode: 'custom' }));
      return;
    }
    setDraft((current) => ({ ...current, mode }));
  }

  function pickDate(day: string) {
    setDraft((current) => {
      if (current.mode !== 'custom' || current.until) {
        return { ...current, mode: 'custom', since: day, until: '' };
      }
      if (!current.since) return { ...current, mode: 'custom', since: day, until: '' };
      if (day < current.since) return { ...current, mode: 'custom', since: day, until: current.since };
      return { ...current, mode: 'custom', until: day };
    });
  }

  function apply() {
    if (!canApply) return;
    onChange(draft.mode === 'custom' ? normalizeValue(draft) : draft);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant="outline"
        className="h-9 w-full justify-start gap-2 px-3 sm:w-auto"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{valueLabel(value)}</span>
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="日期范围选择"
          className="fixed z-[60] max-h-[calc(100vh-5rem)] overflow-y-auto rounded-md border bg-background shadow-lg"
          style={{
            top: panelPosition.top,
            left: panelPosition.left,
            width: panelPosition.width,
          }}
        >
          <div className="grid md:grid-cols-[156px_minmax(0,1fr)]">
            <div className="border-b bg-muted/40 p-2 md:border-b-0 md:border-r">
              <div className="space-y-1">
                {QUICK_RANGES.map((item) => (
                  <button
                    key={item.mode}
                    type="button"
                    className={cn(
                      'flex h-8 w-full items-center rounded-md px-2 text-left text-sm transition-colors hover:bg-background',
                      draft.mode === item.mode && 'bg-background font-medium text-primary shadow-sm',
                    )}
                    onClick={() => pickQuick(item.mode)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-w-0">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 px-0"
                  onClick={() => setLeftMonth((current) => addMonths(current, -1))}
                  aria-label="上个月"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
                <div className="text-sm font-medium">
                  {formatMonth(leftMonth)} - {formatMonth(rightMonth)}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 px-0"
                  onClick={() => setLeftMonth((current) => addMonths(current, 1))}
                  aria-label="下个月"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>

              <div className="grid gap-3 p-3 sm:grid-cols-2">
                <MonthGrid month={leftMonth} draft={draft} onPick={pickDate} />
                <MonthGrid month={rightMonth} draft={draft} onPick={pickDate} />
              </div>

              <div className="flex flex-col gap-2 border-t p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-muted-foreground">
                  {draft.mode === 'custom'
                    ? draft.until
                      ? `${formatDisplayDate(draft.since)} 至 ${formatDisplayDate(draft.until)}`
                      : `${formatDisplayDate(draft.since)} 至 ...`
                    : quickLabel(draft.mode)}
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                    取消
                  </Button>
                  <Button type="button" size="sm" disabled={!canApply} onClick={apply}>
                    应用
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MonthGrid({
  month,
  draft,
  onPick,
}: {
  month: Date;
  draft: DateRangePickerValue;
  onPick: (day: string) => void;
}) {
  const days = useMemo(() => monthCells(month), [month]);
  return (
    <div className="min-w-0">
      <div className="mb-2 text-center text-sm font-medium">{formatMonth(month)}</div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {WEEKDAYS.map((day) => (
          <div key={day} className="h-7 leading-7">
            {day}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day, index) => {
          if (!day) return <div key={`blank-${index}`} className="h-8" />;
          const state = dayState(day, draft);
          return (
            <button
              key={day}
              type="button"
              className={cn(
                'h-8 rounded-md text-sm transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                state.inRange && 'bg-primary/10 text-primary',
                state.edge && 'bg-primary text-primary-foreground hover:bg-primary',
                state.today && !state.edge && 'border border-primary/40',
              )}
              onClick={() => onPick(day)}
            >
              {Number(day.slice(-2))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function dayState(day: string, value: DateRangePickerValue): { edge: boolean; inRange: boolean; today: boolean } {
  const today = day === formatDateInput(new Date());
  if (value.mode !== 'custom') return { edge: false, inRange: false, today };
  const edge = day === value.since || day === value.until;
  const inRange = !!value.since && !!value.until && value.since < day && day < value.until;
  return { edge, inRange, today };
}

function monthCells(month: Date): Array<string | null> {
  const first = monthStart(month);
  const total = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: Array<string | null> = Array.from({ length: first.getDay() }, () => null);
  for (let day = 1; day <= total; day++) {
    cells.push(formatDateInput(new Date(first.getFullYear(), first.getMonth(), day)));
  }
  return cells;
}

function normalizeValue(value: DateRangePickerValue): DateRangePickerValue {
  if (!value.since || !value.until || value.since <= value.until) return value;
  return { ...value, since: value.until, until: value.since };
}

function valueLabel(value: DateRangePickerValue): string {
  if (value.mode !== 'custom') return quickLabel(value.mode);
  return `${formatDisplayDate(value.since)} - ${formatDisplayDate(value.until)}`;
}

function quickLabel(mode: DateMode): string {
  return QUICK_RANGES.find((item) => item.mode === mode)?.label ?? '日期范围';
}

function formatDisplayDate(value: string): string {
  if (!value) return '';
  const date = dateFromKey(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatMonth(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

function dateFromKey(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year || new Date().getFullYear(), (month || 1) - 1, day || 1);
}

function formatDateInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
