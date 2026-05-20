import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  api,
  openTaskStream,
  type DatePreset,
  type InsightsSummary,
  type CopyParams,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CopyDialog } from '@/components/CopyDialog';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';

/* ===================== 类型 ===================== */
export interface EntityRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
  effectiveStatus?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export interface EntityListViewProps<T extends EntityRow> {
  layer: 'campaign' | 'adset' | 'ad';
  layerLabel: string; // "系列" / "广告组" / "广告"
  adAccountId: string;
  rows: T[];
  isLoading: boolean;
  error?: unknown;
  refetch: () => void;
  /** 点击行名跳到下一层(undefined 表示无下钻,如 ad 层) */
  drillTo?: (row: T) => { to: string; params: Record<string, string> };
  /** 该层是否支持预算编辑(ad 层 false) */
  enableBudget?: boolean;
  /** 该层货币 */
  currency?: string | null;
  /** insights 数据 */
  insights?: Record<string, InsightsSummary>;
  /** 当前选 preset */
  datePreset: DatePreset;
  onDatePresetChange: (p: DatePreset) => void;
  /** 用于 invalidate 父查询 */
  invalidateKey: unknown[];
}

const TASK_TERMINAL: Array<'success' | 'failed' | 'partial' | 'cancelled'> = [
  'success',
  'failed',
  'partial',
  'cancelled',
];

interface ProgressSnap {
  taskId: string;
  total: number;
  success: number;
  failed: number;
  status: 'pending' | 'running' | 'partial' | 'success' | 'failed' | 'cancelled';
}

const PRESETS: DatePreset[] = ['today', 'yesterday', 'last_7d', 'last_30d', 'lifetime'];

/* ===================== 主组件 ===================== */
export function EntityListView<T extends EntityRow>({
  layer,
  layerLabel,
  adAccountId,
  rows,
  isLoading,
  error,
  refetch,
  drillTo,
  enableBudget = true,
  currency,
  insights,
  datePreset,
  onDatePresetChange,
  invalidateKey,
}: EntityListViewProps<T>) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [budgetEditing, setBudgetEditing] = useState<{ id: string; name: string; daily?: number } | null>(null);
  const [batchBudgetOpen, setBatchBudgetOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState<{ ids: string[]; hint?: string } | null>(null);
  const [activeTask, setActiveTask] = useState<string | null>(null);

  // 搜索 + 状态筛选(客户端过滤)
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filteredRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          matchText(r.name, search) &&
          (!statusFilter || r.status === statusFilter),
      ),
    [rows, search, statusFilter],
  );

  const allIds = useMemo(() => filteredRows.map((r) => r.id), [filteredRows]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    // 只对当前过滤可见的项操作,保留过滤外已选项
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of allIds) next.delete(id);
      } else {
        for (const id of allIds) next.add(id);
      }
      return next;
    });
  }

  /* ----- mutations ----- */
  const setStatus = useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string;
      status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
    }) => api.setStatus(layer, id, adAccountId, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
  });
  const setBudgetMut = useMutation({
    mutationFn: ({ id, dailyBudget }: { id: string; dailyBudget: number }) =>
      api.setBudget(layer as 'campaign' | 'adset', id, adAccountId, { dailyBudget }),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
  });
  const copyMut = useMutation({
    mutationFn: ({ id, params }: { id: string; params: CopyParams }) =>
      api.copyEntity(layer, id, adAccountId, params),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteEntity(layer, id, adAccountId, false),
    onSuccess: () => qc.invalidateQueries({ queryKey: invalidateKey }),
  });
  const batch = useMutation({
    mutationFn: (req: { action: string; params: Record<string, unknown>; ids: string[] }) =>
      api.batchOperations({
        action: req.action as 'campaign:status' | 'campaign:budget' | 'campaign:copy' | 'campaign:delete' | 'adset:status' | 'adset:budget' | 'adset:copy' | 'adset:delete' | 'ad:status' | 'ad:copy' | 'ad:delete',
        params: req.params,
        targets: req.ids.map((id) => ({
          ad_account_id: adAccountId,
          target_type: layer,
          target_id: id,
        })),
      }),
    onSuccess: (r) => setActiveTask(r.taskId),
  });

  /* ----- helpers ----- */
  function statusFromSwitch(currentStatus: T['status']): 'ACTIVE' | 'PAUSED' {
    return currentStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
  }

  function singleCopyClicked(row: T) {
    setCopyOpen({ ids: [row.id], hint: `源: ${row.name}` });
  }
  function batchCopyClicked() {
    if (selected.size === 0) return;
    setCopyOpen({ ids: Array.from(selected), hint: `共 ${selected.size} 个源` });
  }
  function doCopy(params: CopyParams) {
    if (!copyOpen) return;
    if (copyOpen.ids.length === 1) {
      copyMut.mutate(
        { id: copyOpen.ids[0]!, params },
        { onSuccess: () => setCopyOpen(null) },
      );
    } else {
      // 走批量入队
      batch.mutate(
        {
          action: `${layer}:copy`,
          params: params as unknown as Record<string, unknown>,
          ids: copyOpen.ids,
        },
        {
          onSuccess: () => {
            setCopyOpen(null);
            setSelected(new Set());
          },
        },
      );
    }
  }

  /* ===== render ===== */
  const fmtBudget = (minor?: number) =>
    minor !== undefined ? `${(minor / 100).toFixed(2)} ${currency ?? ''}`.trim() : '-';
  const fmtMoney = (v: number) =>
    v === 0 ? '-' : `${v.toFixed(2)}${currency ? ' ' + currency : ''}`;

  const layerActionLabel: Record<typeof layer, string> = {
    campaign: '系列',
    adset: '广告组',
    ad: '广告',
  };

  return (
    <div className="space-y-3">
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">{layerLabel}</h2>
          {selected.size > 0 && (
            <span className="text-sm text-muted-foreground">
              已选 {selected.size}
              {filteredRows.length !== rows.length && '(跨筛选)'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={datePreset}
            onChange={(e) => onDatePresetChange(e.target.value as DatePreset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p === 'last_7d' ? '近 7 天' : p === 'last_30d' ? '近 30 天' : p === 'today' ? '今天' : p === 'yesterday' ? '昨天' : '全部'}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={refetch}>
            刷新
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected.size === 0 || batch.isPending}
            onClick={() =>
              batch.mutate({
                action: `${layer}:status`,
                params: { status: 'PAUSED' },
                ids: Array.from(selected),
              })
            }
          >
            批量暂停
          </Button>
          <Button
            size="sm"
            disabled={selected.size === 0 || batch.isPending}
            onClick={() =>
              batch.mutate({
                action: `${layer}:status`,
                params: { status: 'ACTIVE' },
                ids: Array.from(selected),
              })
            }
          >
            批量启用
          </Button>
          {enableBudget && (
            <Button
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || batch.isPending}
              onClick={() => setBatchBudgetOpen(true)}
            >
              批量改预算
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={selected.size === 0 || batch.isPending}
            onClick={batchCopyClicked}
          >
            批量复制
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={selected.size === 0 || batch.isPending}
            onClick={() => {
              if (!confirm(`批量归档 ${selected.size} 个${layerActionLabel[layer]}？`)) return;
              batch.mutate({
                action: `${layer}:delete`,
                params: { hard: false },
                ids: Array.from(selected),
              });
            }}
          >
            批量归档
          </Button>
        </div>
      </div>

      {/* 搜索 + 筛选 */}
      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder={`搜索${layerLabel}名称…`}
        filters={[
          {
            key: 'status',
            label: '状态',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: '', label: '全部' },
              { value: 'ACTIVE', label: 'ACTIVE' },
              { value: 'PAUSED', label: 'PAUSED' },
              { value: 'ARCHIVED', label: 'ARCHIVED' },
            ],
          },
        ]}
        total={rows.length}
        filtered={filteredRows.length}
        onReset={() => {
          setSearch('');
          setStatusFilter('');
        }}
      />

      {(error || setStatus.error || setBudgetMut.error || copyMut.error || deleteMut.error || batch.error) && (
        <p className="text-sm text-destructive">
          {(error as Error)?.message ||
            (setStatus.error as Error)?.message ||
            (setBudgetMut.error as Error)?.message ||
            (copyMut.error as Error)?.message ||
            (deleteMut.error as Error)?.message ||
            (batch.error as Error)?.message}
        </p>
      )}

      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              </TableHead>
              <TableHead className="w-12"></TableHead>
              <TableHead>名称</TableHead>
              {enableBudget && <TableHead>日预算</TableHead>}
              <TableHead className="text-right">花费</TableHead>
              <TableHead className="text-right">订单</TableHead>
              <TableHead className="text-right">CPA</TableHead>
              <TableHead className="text-right">CPC</TableHead>
              <TableHead className="text-right">加购</TableHead>
              <TableHead className="text-right">结账</TableHead>
              <TableHead className="text-right">CPM</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={enableBudget ? 12 : 11} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={enableBudget ? 12 : 11} className="text-muted-foreground">
                  无{layerLabel}。
                </TableCell>
              </TableRow>
            )}
            {!isLoading && rows.length > 0 && filteredRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={enableBudget ? 12 : 11} className="text-muted-foreground">
                  无匹配项。试试清除筛选条件。
                </TableCell>
              </TableRow>
            )}
            {filteredRows.map((r) => {
              const ins = insights?.[r.id];
              const isSel = selected.has(r.id);
              const archived = r.status === 'ARCHIVED' || r.status === 'DELETED';
              const drill = drillTo?.(r);
              return (
                <TableRow key={r.id} className={isSel ? 'bg-muted/30' : ''}>
                  <TableCell>
                    <input type="checkbox" checked={isSel} onChange={() => toggle(r.id)} />
                  </TableCell>
                  <TableCell>
                    <Switch
                      size="sm"
                      checked={r.status === 'ACTIVE'}
                      disabled={archived || setStatus.isPending}
                      onCheckedChange={() =>
                        setStatus.mutate({ id: r.id, status: statusFromSwitch(r.status) })
                      }
                      aria-label={`status-${r.id}`}
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    {drill ? (
                      <Link
                        to={drill.to}
                        params={drill.params}
                        className="text-primary hover:underline"
                      >
                        {r.name}
                      </Link>
                    ) : (
                      r.name
                    )}
                    {r.status !== 'ACTIVE' && (
                      <span className="ml-2 text-xs text-muted-foreground">[{r.status}]</span>
                    )}
                  </TableCell>
                  {enableBudget && (
                    <TableCell>
                      <button
                        onClick={() => setBudgetEditing({ id: r.id, name: r.name, ...(r.dailyBudget !== undefined ? { daily: r.dailyBudget } : {}) })}
                        disabled={archived}
                        className="text-left hover:underline disabled:opacity-50"
                      >
                        {fmtBudget(r.dailyBudget)}
                      </button>
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">{ins ? fmtMoney(ins.spend) : '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{ins ? (ins.orders || '-') : '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{ins ? (ins.cpa ? fmtMoney(ins.cpa) : '-') : '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{ins ? (ins.cpc ? ins.cpc.toFixed(2) : '-') : '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{ins ? (ins.addToCart || '-') : '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{ins ? (ins.initiateCheckout || '-') : '-'}</TableCell>
                  <TableCell className="text-right tabular-nums">{ins ? (ins.cpm ? ins.cpm.toFixed(2) : '-') : '-'}</TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={archived || copyMut.isPending}
                      onClick={() => singleCopyClicked(r)}
                    >
                      复制
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={archived || deleteMut.isPending}
                      onClick={() => {
                        if (!confirm(`归档 "${r.name}" ?`)) return;
                        deleteMut.mutate(r.id);
                      }}
                    >
                      归档
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* 单 budget */}
      <BudgetEditDialog
        open={!!budgetEditing}
        layer={layer}
        currency={currency ?? null}
        target={budgetEditing}
        onCancel={() => setBudgetEditing(null)}
        submitting={setBudgetMut.isPending}
        onSubmit={(daily) => {
          if (budgetEditing) {
            setBudgetMut.mutate(
              { id: budgetEditing.id, dailyBudget: daily },
              { onSuccess: () => setBudgetEditing(null) },
            );
          }
        }}
      />

      {/* 批量 budget */}
      <BudgetEditDialog
        open={batchBudgetOpen}
        layer={layer}
        currency={currency ?? null}
        target={{ id: '_batch_', name: `批量 ${selected.size} 个` }}
        onCancel={() => setBatchBudgetOpen(false)}
        submitting={batch.isPending}
        onSubmit={(daily) => {
          setBatchBudgetOpen(false);
          batch.mutate({
            action: `${layer}:budget`,
            params: { dailyBudget: daily },
            ids: Array.from(selected),
          });
        }}
      />

      {/* 复制 */}
      <CopyDialog
        open={!!copyOpen}
        layer={layer}
        targetCount={copyOpen?.ids.length ?? 0}
        {...(copyOpen?.hint ? { hint: copyOpen.hint } : {})}
        onCancel={() => setCopyOpen(null)}
        onSubmit={doCopy}
        submitting={copyMut.isPending || batch.isPending}
      />

      {/* SSE 任务进度 */}
      <TaskProgress
        taskId={activeTask}
        onClose={() => {
          setActiveTask(null);
          setSelected(new Set());
          qc.invalidateQueries({ queryKey: invalidateKey });
        }}
      />
    </div>
  );
}

/* ===================== Budget Dialog ===================== */
function BudgetEditDialog({
  open,
  layer,
  currency,
  target,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  layer: 'campaign' | 'adset' | 'ad';
  currency: string | null;
  target: { id: string; name: string; daily?: number } | null;
  onCancel: () => void;
  onSubmit: (dailyMinor: number) => void;
  submitting: boolean;
}) {
  const [val, setVal] = useState('');
  useEffect(() => {
    if (open) {
      setVal(target?.daily !== undefined ? (target.daily / 100).toFixed(2) : '');
    }
  }, [open, target?.daily]);

  if (layer === 'ad') return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !submitting && onCancel()}
      title={`日预算 · ${target?.name ?? ''}`}
    >
      <p className="text-sm text-muted-foreground mb-2">
        单位 {currency ?? '主单位'}(提交时 ×100 转最小单位)
      </p>
      <Input
        type="number"
        step="0.01"
        min="0.01"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        autoFocus
      />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button
          onClick={() => {
            const n = Number(val);
            if (!Number.isFinite(n) || n <= 0) {
              alert('请输入正数');
              return;
            }
            onSubmit(Math.round(n * 100));
          }}
          disabled={submitting}
        >
          {submitting ? '提交中…' : '提交'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ===================== Task progress ===================== */
function TaskProgress({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const [snap, setSnap] = useState<ProgressSnap | null>(null);
  useEffect(() => {
    if (!taskId) return;
    setSnap(null);
    const es = openTaskStream(taskId);
    es.addEventListener('progress', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as ProgressSnap;
        setSnap(data);
        if (TASK_TERMINAL.includes(data.status as 'success' | 'failed' | 'partial' | 'cancelled')) {
          es.close();
        }
      } catch {
        /* */
      }
    });
    return () => {
      es.close();
    };
  }, [taskId]);

  if (!taskId) return null;
  const pct = snap && snap.total > 0
    ? Math.round(((snap.success + snap.failed) / snap.total) * 100)
    : 0;
  const terminal =
    !!snap &&
    TASK_TERMINAL.includes(snap.status as 'success' | 'failed' | 'partial' | 'cancelled');

  return (
    <Dialog open onOpenChange={(o) => !o && terminal && onClose()} title="任务进度">
      <p className="text-xs text-muted-foreground font-mono">task: {taskId}</p>
      <div className="mt-3 mb-2 h-2 rounded bg-muted overflow-hidden">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm">
        {snap ? (
          <>
            <b>{snap.status}</b> · {snap.success}/{snap.total} 成功 · {snap.failed} 失败 ({pct}%)
          </>
        ) : (
          '连接中…'
        )}
      </p>
      <DialogFooter>
        <Button
          variant={terminal ? 'default' : 'outline'}
          onClick={onClose}
          disabled={!terminal && !snap}
        >
          {terminal ? '完成' : '在后台运行'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
