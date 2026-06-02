import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Copy, Pause, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react';
import {
  api,
  openTaskStream,
  type CopyParams,
  type DatePreset,
  type InsightsSummary,
  type Me,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CopyDialog } from '@/components/CopyDialog';
import { Pagination, usePagination } from '@/components/Pagination';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';
import { SelectionClearPill } from '@/components/SelectionClearPill';
import { metaEffectiveStatusLabel, metaEntityStatusLabel, taskStatusLabel } from '@/lib/labels';

export interface EntityRow {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
  effectiveStatus?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  startTime?: string;
  stopTime?: string;
  endTime?: string;
  adsetStartTime?: string;
  adsetEndTime?: string;
}

export type EntityLayer = 'campaign' | 'adset' | 'ad';

export interface CopySelection {
  layer: EntityLayer;
  ids: string[];
  hint?: string;
  forceDeepCopy?: boolean;
}

export interface EntityListViewProps<T extends EntityRow> {
  layer: EntityLayer;
  layerLabel: string;
  adAccountId: string;
  rows: T[];
  isLoading: boolean;
  error?: unknown;
  refetch: () => void;
  drillTo?: (row: T) => { to: string; params: Record<string, string> };
  onRowOpen?: (row: T) => void;
  enableBudget?: boolean;
  currency?: string | null;
  adAccountTimezone?: string | null;
  insights?: Record<string, InsightsSummary>;
  datePreset: DatePreset;
  onDatePresetChange: (p: DatePreset) => void;
  invalidateKey: unknown[];
  selectedIds?: Set<string>;
  onSelectedIdsChange?: (ids: Set<string>) => void;
  resolveBatchCopySelection?: (selection: CopySelection) => CopySelection;
  scopeLabel?: string;
  emptyText?: string;
  showDatePreset?: boolean;
}

type TerminalTaskStatus = 'success' | 'failed' | 'partial' | 'cancelled';
type TaskStatus = 'pending' | 'running' | 'paused' | TerminalTaskStatus;
type RowPatch = Partial<Pick<EntityRow, 'status' | 'dailyBudget' | 'lifetimeBudget'>>;
type SortMetric = 'spend' | 'orders' | 'cpa' | 'cpc' | 'addToCart' | 'initiateCheckout' | 'cpm' | 'roi';
type SortDirection = 'asc' | 'desc';
type SortState = { metric: SortMetric; direction: SortDirection };
type BatchState = {
  action: string;
  params: Record<string, unknown>;
  ids: string[];
  targetLayer: EntityLayer;
};
type CopyOpenState = CopySelection;

interface ProgressSnap {
  taskId: string;
  total: number;
  success: number;
  failed: number;
  status: TaskStatus;
  updatedAt?: number;
}

interface InsightSummaryTotal {
  rows: number;
  hasInsights: boolean;
  spend: number;
  impressions: number;
  clicks: number;
  orders: number;
  cpa: number;
  cpc: number;
  addToCart: number;
  initiateCheckout: number;
  cpm: number;
  roi: number;
  roiCount: number;
}

const TASK_TERMINAL: TerminalTaskStatus[] = ['success', 'failed', 'partial', 'cancelled'];
const PRESETS: DatePreset[] = ['today', 'yesterday', 'last_7d', 'last_30d', 'maximum'];
const METRIC_COLUMNS: Array<{ metric: SortMetric; label: string }> = [
  { metric: 'spend', label: '花费' },
  { metric: 'orders', label: '订单' },
  { metric: 'cpa', label: 'CPA' },
  { metric: 'cpc', label: 'CPC' },
  { metric: 'addToCart', label: '加购' },
  { metric: 'initiateCheckout', label: '结账' },
  { metric: 'cpm', label: 'CPM' },
  { metric: 'roi', label: 'ROI' },
];

function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return (TASK_TERMINAL as readonly string[]).includes(status);
}

export function EntityListView<T extends EntityRow>({
  layer,
  layerLabel,
  adAccountId,
  rows,
  isLoading,
  error,
  refetch,
  drillTo,
  onRowOpen,
  enableBudget = true,
  currency,
  insights,
  datePreset,
  onDatePresetChange,
  invalidateKey,
  selectedIds,
  onSelectedIdsChange,
  resolveBatchCopySelection,
  scopeLabel,
  emptyText,
  showDatePreset = true,
}: EntityListViewProps<T>) {
  const [internalSelected, setInternalSelected] = useState<Set<string>>(new Set());
  const [rowPatches, setRowPatches] = useState<Map<string, RowPatch>>(new Map());
  const [budgetEditing, setBudgetEditing] = useState<{ id: string; name: string; daily?: number } | null>(null);
  const [batchBudgetOpen, setBatchBudgetOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState<CopyOpenState | null>(null);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [trackedTaskId, setTrackedTaskId] = useState<string | null>(null);
  const [pendingBatch, setPendingBatch] = useState<BatchState | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [activeFirst, setActiveFirst] = useState(true);
  const previousKeySignature = useRef<string | null>(null);
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const selected = selectedIds ?? internalSelected;
  const selectionControlled = selectedIds !== undefined;

  function replaceSelected(next: Set<string>) {
    if (!selectionControlled) setInternalSelected(next);
    onSelectedIdsChange?.(next);
  }

  function updateSelected(producer: (current: Set<string>) => Set<string>) {
    replaceSelected(producer(selected));
  }

  const keySignature = JSON.stringify(invalidateKey);
  useEffect(() => {
    setRowPatches(new Map());
    if (previousKeySignature.current !== null && previousKeySignature.current !== keySignature) {
      replaceSelected(new Set());
    }
    previousKeySignature.current = keySignature;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature]);

  const patchedRows = useMemo(
    () => rows.map((row) => applyPatch(row, rowPatches.get(row.id))),
    [rows, rowPatches],
  );

  const filteredRows = useMemo(
    () =>
      patchedRows.filter(
        (row) =>
          matchText(row.name, search) &&
          (!statusFilter || row.status === statusFilter),
      ),
    [patchedRows, search, statusFilter],
  );

  const sortedRows = useMemo(
    () => sortRows(filteredRows, insights, sort, activeFirst),
    [activeFirst, filteredRows, insights, sort],
  );

  const pager = usePagination(sortedRows);
  const allIds = useMemo(() => pager.pageItems.map((row) => row.id), [pager.pageItems]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const summaryRows = useMemo(() => {
    if (selected.size === 0) return sortedRows;
    return patchedRows.filter((row) => selected.has(row.id));
  }, [patchedRows, selected, sortedRows]);
  const summary = useMemo(
    () => summarizeInsights(summaryRows, insights),
    [insights, summaryRows],
  );
  const visibleMetricColumns = METRIC_COLUMNS;
  const tableColumnCount = 4 + (enableBudget ? 1 : 0) + visibleMetricColumns.length + 1;

  function patchRows(ids: string[], patch: RowPatch) {
    setRowPatches((current) => {
      const next = new Map(current);
      for (const id of ids) {
        next.set(id, { ...(next.get(id) ?? {}), ...patch });
      }
      return next;
    });
  }

  function toggle(id: string) {
    updateSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    updateSelected((current) => {
      const next = new Set(current);
      if (allSelected) {
        for (const id of allIds) next.delete(id);
      } else {
        for (const id of allIds) next.add(id);
      }
      return next;
    });
  }

  function toggleSort(metric: SortMetric) {
    setSort((current) => {
      if (current?.metric !== metric) return { metric, direction: 'desc' };
      return { metric, direction: current.direction === 'desc' ? 'asc' : 'desc' };
    });
    pager.setPage(1);
  }

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' }) =>
      api.setStatus(layer, id, adAccountId, status),
    onSuccess: (_data, variables) => {
      patchRows([variables.id], { status: variables.status });
    },
  });

  const setBudgetMut = useMutation({
    mutationFn: ({ id, dailyBudget }: { id: string; dailyBudget: number }) =>
      api.setBudget(layer as 'campaign' | 'adset', id, adAccountId, { dailyBudget }),
    onSuccess: (_data, variables) => {
      patchRows([variables.id], { dailyBudget: variables.dailyBudget });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteEntity(layer, id, adAccountId, false),
    onSuccess: (_data, id) => {
      patchRows([id], { status: 'ARCHIVED' });
    },
  });

  const batch = useMutation({
    mutationFn: (req: BatchState) =>
      api.batchOperations({
        action: req.action as Parameters<typeof api.batchOperations>[0]['action'],
        params: req.params,
        targets: req.ids.map((id) => ({
          ad_account_id: adAccountId,
          target_type: req.targetLayer,
          target_id: id,
        })),
      }),
    onSuccess: (result, variables) => {
      setPendingBatch(variables);
      setActiveTask(result.taskId);
      setTrackedTaskId(result.taskId);
    },
  });

  const trackedTask = useQuery({
    queryKey: ['task-status', trackedTaskId],
    queryFn: () => api.taskStatus(trackedTaskId!),
    enabled: !!trackedTaskId,
    refetchInterval: 2000,
  });

  useEffect(() => {
    const task = trackedTask.data;
    if (!trackedTaskId || !task || !isTerminalTaskStatus(task.status)) return;
    if (pendingBatch && task.status !== 'failed') {
      const failedIds = new Set(task.failures.map((item) => item.targetId));
      applyBatchPatch(pendingBatch, pendingBatch.ids.filter((id) => !failedIds.has(id)), patchRows);
    }
    replaceSelected(new Set());
    setTrackedTaskId(null);
    setPendingBatch(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBatch, trackedTask.data, trackedTaskId]);

  function runBatch(
    action: string,
    params: Record<string, unknown>,
    ids = Array.from(selected),
    targetLayer: EntityLayer = layer,
  ) {
    if (ids.length === 0) return;
    batch.mutate({ action, params, ids, targetLayer });
  }

  function statusFromSwitch(currentStatus: T['status']): 'ACTIVE' | 'PAUSED' {
    return currentStatus === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
  }

  function singleCopyClicked(row: T) {
    setCopyOpen({ layer, ids: [row.id], hint: `来源：${row.name}` });
  }

  function batchCopyClicked() {
    if (selected.size === 0) return;
    const selectedIds = Array.from(selected);
    const copySelection: CopySelection = {
      layer,
      ids: selectedIds,
      hint: `共 ${selected.size} 个来源`,
    };
    setCopyOpen(resolveBatchCopySelection?.(copySelection) ?? copySelection);
  }

  function doCopy(params: CopyParams) {
    if (!copyOpen) return;
    runBatch(
      `${copyOpen.layer}:copy`,
      params as unknown as Record<string, unknown>,
      copyOpen.ids,
      copyOpen.layer,
    );
    setCopyOpen(null);
  }

  const fmtBudget = (minor?: number) =>
    minor !== undefined ? `${(minor / 100).toFixed(2)} ${currency ?? ''}`.trim() : '-';
  const fmtMoney = (value: number) =>
    value === 0 ? '-' : `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`;

  const layerActionLabel = layer === 'campaign' ? '广告系列' : layer === 'adset' ? '广告组' : '广告';
  const selectedCrossesFilter = selected.size > 0 && filteredRows.length !== rows.length;
  const canOperateAdAccount =
    me.data?.scope.bypass || me.data?.scope.adAccounts.includes(adAccountId) || false;
  const hasPermission = (code: string) => me.data?.permissions.includes(code) ?? false;
  const canChangeStatus = canOperateAdAccount && hasPermission('campaign:status');
  const canChangeBudget = canOperateAdAccount && enableBudget && hasPermission('campaign:budget');
  const canCopy = canOperateAdAccount && hasPermission('campaign:copy');
  const canDelete = canOperateAdAccount && hasPermission('campaign:delete');

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="font-medium">{layerLabel}</h2>
          {scopeLabel && (
            <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
              {scopeLabel}
            </span>
          )}
          <SelectionClearPill
            count={selected.size}
            itemLabel={layerActionLabel}
            detail={selectedCrossesFilter ? '跨筛选' : undefined}
            onClear={() => replaceSelected(new Set())}
          />
        </div>
        <div className="flex flex-col gap-2 xl:items-end">
          <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">
            <label className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-2 text-sm sm:w-auto">
              <Switch
                size="sm"
                checked={activeFirst}
                onCheckedChange={(next) => {
                  setActiveFirst(next);
                  pager.setPage(1);
                }}
                aria-label="active-first"
              />
              <span>启用优先</span>
            </label>
            {showDatePreset && (
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto"
                value={datePreset}
                onChange={(event) => onDatePresetChange(event.target.value as DatePreset)}
              >
                {PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {presetLabel(preset)}
                  </option>
                ))}
              </select>
            )}
            <Button size="sm" variant="outline" className="w-full gap-1.5 sm:w-auto" onClick={refetch}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              刷新
            </Button>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5 sm:w-auto"
              disabled={selected.size === 0 || batch.isPending || !canChangeStatus}
              onClick={() => runBatch(`${layer}:status`, { status: 'PAUSED' })}
            >
              <Pause className="h-4 w-4" aria-hidden="true" />
              批量暂停
            </Button>
            <Button
              size="sm"
              className="w-full gap-1.5 sm:w-auto"
              disabled={selected.size === 0 || batch.isPending || !canChangeStatus}
              onClick={() => runBatch(`${layer}:status`, { status: 'ACTIVE' })}
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              批量启用
            </Button>
            {enableBudget && (
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1.5 sm:w-auto"
                disabled={selected.size === 0 || batch.isPending || !canChangeBudget}
                onClick={() => setBatchBudgetOpen(true)}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                批量改预算
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5 sm:w-auto"
              disabled={selected.size === 0 || batch.isPending || !canCopy}
              onClick={batchCopyClicked}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              批量复制
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="w-full gap-1.5 sm:w-auto"
              disabled={selected.size === 0 || batch.isPending || !canDelete}
              onClick={() => {
                if (!confirm(`批量删除 ${selected.size} 个${layerActionLabel}？`)) return;
                runBatch(`${layer}:delete`, { hard: false });
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              批量删除
            </Button>
          </div>
        </div>
      </div>

      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder={`搜索${layerLabel}名称...`}
        filters={[
          {
            key: 'status',
            label: '状态',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: '', label: '全部' },
              { value: 'ACTIVE', label: metaEntityStatusLabel('ACTIVE') },
              { value: 'PAUSED', label: metaEntityStatusLabel('PAUSED') },
              { value: 'ARCHIVED', label: metaEntityStatusLabel('ARCHIVED') },
              { value: 'DELETED', label: metaEntityStatusLabel('DELETED') },
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

      {(error || setStatus.error || setBudgetMut.error || deleteMut.error || batch.error || trackedTask.error) && (
        <p className="text-sm text-destructive">
          {(error as Error)?.message ||
            (setStatus.error as Error)?.message ||
            (setBudgetMut.error as Error)?.message ||
            (deleteMut.error as Error)?.message ||
            (batch.error as Error)?.message ||
            (trackedTask.error as Error)?.message}
        </p>
      )}

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 px-2 text-center">
                <label className="flex min-h-10 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    className="h-5 w-5 cursor-pointer accent-primary"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label={`选择全部${layerLabel}`}
                  />
                </label>
              </TableHead>
              <TableHead className="w-12" />
              <TableHead className="min-w-[220px]">名称</TableHead>
              <TableHead>状态</TableHead>
              {enableBudget && <TableHead>日预算</TableHead>}
              {visibleMetricColumns.map((column) => (
                <SortableMetricHead
                  key={column.metric}
                  metric={column.metric}
                  label={column.label}
                  sort={sort}
                  onSort={toggleSort}
                />
              ))}
              <TableHead className="whitespace-nowrap text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <EmptyTableRow colSpan={tableColumnCount} text="加载中..." />
            )}
            {!isLoading && rows.length === 0 && (
              <EmptyTableRow colSpan={tableColumnCount} text={emptyText ?? `暂无${layerLabel}`} />
            )}
            {!isLoading && rows.length > 0 && filteredRows.length === 0 && (
              <EmptyTableRow colSpan={tableColumnCount} text="无匹配项，请清除筛选条件" />
            )}
            {pager.pageItems.map((row) => {
              const insight = insights?.[row.id];
              const isSelected = selected.has(row.id);
              const archived = row.status === 'ARCHIVED' || row.status === 'DELETED';
              const drill = onRowOpen ? undefined : drillTo?.(row);
              return (
                <TableRow key={row.id} className={isSelected ? 'bg-muted/30' : ''}>
                  <TableCell className="w-12 px-2 text-center">
                    <label className="flex min-h-10 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5 cursor-pointer accent-primary"
                        checked={isSelected}
                        onChange={() => toggle(row.id)}
                        aria-label={`选择${row.name}`}
                      />
                    </label>
                  </TableCell>
                  <TableCell>
                    <Switch
                      size="sm"
                      checked={row.status === 'ACTIVE'}
                      disabled={archived || setStatus.isPending || !canChangeStatus}
                      onCheckedChange={() =>
                        setStatus.mutate({ id: row.id, status: statusFromSwitch(row.status) })
                      }
                      aria-label={`status-${row.id}`}
                    />
                  </TableCell>
                  <TableCell className="min-w-[220px] max-w-[420px] font-medium">
                    {onRowOpen ? (
                      <button
                        type="button"
                        className="block max-w-full truncate text-left text-primary hover:underline"
                        title={row.name}
                        onClick={() => onRowOpen(row)}
                      >
                        {row.name}
                      </button>
                    ) : drill ? (
                      <Link
                        to={drill.to}
                        params={drill.params}
                        className="block truncate text-primary hover:underline"
                        title={row.name}
                      >
                        {row.name}
                      </Link>
                    ) : (
                      <span className="block truncate" title={row.name}>{row.name}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DeliveryStatusBadge row={row} />
                  </TableCell>
                  {enableBudget && (
                    <TableCell>
                      <button
                        type="button"
                        onClick={() =>
                          setBudgetEditing({
                            id: row.id,
                            name: row.name,
                            ...(row.dailyBudget !== undefined ? { daily: row.dailyBudget } : {}),
                          })
                        }
                        disabled={archived || !canChangeBudget}
                        className="text-left hover:underline disabled:opacity-50"
                      >
                        {fmtBudget(row.dailyBudget)}
                      </button>
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {insight ? fmtMoney(insight.spend) : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {insight ? insight.orders || '-' : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {insight ? (insight.cpa ? fmtMoney(insight.cpa) : '-') : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {insight ? (insight.cpc ? insight.cpc.toFixed(2) : '-') : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {insight ? insight.addToCart || '-' : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {insight ? insight.initiateCheckout || '-' : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {insight ? (insight.cpm ? insight.cpm.toFixed(2) : '-') : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {insight ? (insight.roi ? insight.roi.toFixed(2) : '-') : '-'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={archived || batch.isPending || !canCopy}
                        onClick={() => singleCopyClicked(row)}
                      >
                        复制
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={archived || deleteMut.isPending || !canDelete}
                        onClick={() => {
                          if (!confirm(`删除 "${row.name}"？`)) return;
                          deleteMut.mutate(row.id);
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <SummaryRow
              mode={selected.size > 0 ? 'selected' : 'all'}
              summary={summary}
              currency={currency ?? null}
              enableBudget={enableBudget}
            />
          </TableFooter>
        </Table>
        <Pagination
          page={pager.page}
          pageCount={pager.pageCount}
          total={sortedRows.length}
          onPageChange={pager.setPage}
        />
      </div>

      <BudgetEditDialog
        open={!!budgetEditing}
        layer={layer}
        currency={currency ?? null}
        target={budgetEditing}
        onCancel={() => setBudgetEditing(null)}
        submitting={setBudgetMut.isPending}
        onSubmit={(daily) => {
          if (!budgetEditing) return;
          setBudgetMut.mutate(
            { id: budgetEditing.id, dailyBudget: daily },
            { onSuccess: () => setBudgetEditing(null) },
          );
        }}
      />

      <BudgetEditDialog
        open={batchBudgetOpen}
        layer={layer}
        currency={currency ?? null}
        target={{ id: '_batch_', name: `批量 ${selected.size} 个` }}
        onCancel={() => setBatchBudgetOpen(false)}
        submitting={batch.isPending}
        onSubmit={(daily) => {
          setBatchBudgetOpen(false);
          runBatch(`${layer}:budget`, { dailyBudget: daily });
        }}
      />

      <CopyDialog
        open={!!copyOpen}
        layer={copyOpen?.layer ?? layer}
        targetCount={copyOpen?.ids.length ?? 0}
        {...(copyOpen?.hint ? { hint: copyOpen.hint } : {})}
        forceDeepCopy={copyOpen?.forceDeepCopy === true}
        onCancel={() => setCopyOpen(null)}
        onSubmit={doCopy}
        submitting={batch.isPending}
      />

      <TaskProgress
        taskId={activeTask}
        onClose={() => {
          setActiveTask(null);
        }}
      />
    </div>
  );
}

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
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) setValue(target?.daily !== undefined ? (target.daily / 100).toFixed(2) : '');
  }, [open, target?.daily]);

  if (layer === 'ad') return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && !submitting && onCancel()}
      title={`日预算 - ${target?.name ?? ''}`}
    >
      <p className="mb-2 text-sm text-muted-foreground">
        单位：{currency ?? '主币种'}，提交时会自动换算为最小货币单位。
      </p>
      <Input
        type="number"
        step="0.01"
        min="0.01"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoFocus
      />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button
          onClick={() => {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) {
              alert('请输入大于 0 的预算');
              return;
            }
            onSubmit(Math.round(n * 100));
          }}
          disabled={submitting}
        >
          {submitting ? '提交中...' : '提交'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function TaskProgress({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const [snap, setSnap] = useState<ProgressSnap | null>(null);
  const [startedAtMs, setStartedAtMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!taskId) return;
    setSnap(null);
    const started = Date.now();
    setStartedAtMs(started);
    setNowMs(started);
    const es = openTaskStream(taskId);
    es.addEventListener('progress', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as ProgressSnap;
        setSnap(data);
        if (isTerminalTaskStatus(data.status)) es.close();
      } catch {
        /* ignore malformed progress event */
      }
    });
    return () => es.close();
  }, [taskId]);

  useEffect(() => {
    if (!taskId || (snap && isTerminalTaskStatus(snap.status))) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [snap, taskId]);

  if (!taskId) return null;
  const pct = snap && snap.total > 0
    ? Math.round(((snap.success + snap.failed) / snap.total) * 100)
    : 0;
  const terminal = !!snap && isTerminalTaskStatus(snap.status);
  const durationEndMs = terminal ? (snap?.updatedAt ?? nowMs) : nowMs;
  const durationSeconds = Math.max(0, Math.floor((durationEndMs - startedAtMs) / 1000));

  return (
    <Dialog open onOpenChange={(open) => !open && terminal && onClose()} title="任务进度">
      <p className="font-mono text-xs text-muted-foreground">task: {taskId}</p>
      <div className="mb-2 mt-3 h-2 overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm">
        {snap ? (
          <>
            <b>{taskStatusLabel(snap.status)}</b> - {snap.success}/{snap.total} 成功 - {snap.failed} 失败
          </>
        ) : (
          '连接中...'
        )}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {terminal ? '完成' : '已用'} {durationSeconds} 秒
      </p>
      <DialogFooter>
        <Button variant={terminal ? 'default' : 'outline'} onClick={onClose} disabled={!terminal && !snap}>
          {terminal ? '完成' : '后台运行'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function EmptyTableRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}

function SortableMetricHead({
  metric,
  label,
  sort,
  onSort,
}: {
  metric: SortMetric;
  label: string;
  sort: SortState | null;
  onSort: (metric: SortMetric) => void;
}) {
  const active = sort?.metric === metric;
  return (
    <TableHead className="whitespace-nowrap text-right">
      <button
        type="button"
        className="inline-flex items-center gap-1 whitespace-nowrap text-right hover:text-primary"
        onClick={() => onSort(metric)}
      >
        <span>{label}</span>
        <span className="w-3 text-xs text-muted-foreground">
          {active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </TableHead>
  );
}

const SUMMARY_CELL_CLASS = 'sticky bottom-0 z-20 whitespace-nowrap bg-[#B9DEFF]';

function SummaryRow({
  mode,
  summary,
  currency,
  enableBudget,
}: {
  mode: 'selected' | 'all';
  summary: InsightSummaryTotal;
  currency: string | null;
  enableBudget?: boolean;
}) {
  const label = mode === 'selected' ? `已选 ${summary.rows} 项` : `全部 ${summary.rows} 项`;
  return (
    <TableRow className="border-t bg-[#B9DEFF] hover:bg-[#B9DEFF]">
      <TableCell className={`${SUMMARY_CELL_CLASS} w-12 px-2`} />
      <TableCell className={`${SUMMARY_CELL_CLASS} w-12`} />
      <TableCell className={`${SUMMARY_CELL_CLASS} font-semibold`}>
        汇总（{label}）
      </TableCell>
      <TableCell className={SUMMARY_CELL_CLASS} />
      {enableBudget && <TableCell className={SUMMARY_CELL_CLASS} />}
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryMoney(summary.spend, currency, summary.hasInsights)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryNumber(summary.orders, summary.hasInsights)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryMoney(summary.cpa, currency, summary.hasInsights && summary.orders > 0)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryDecimal(summary.cpc, summary.hasInsights && summary.clicks > 0)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryNumber(summary.addToCart, summary.hasInsights)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryNumber(summary.initiateCheckout, summary.hasInsights)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryDecimal(summary.cpm, summary.hasInsights && summary.impressions > 0)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right tabular-nums`}>
        {fmtSummaryDecimal(summary.roi, summary.hasInsights && summary.roiCount > 0)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} text-right`} />
    </TableRow>
  );
}

function DeliveryStatusBadge({ row }: { row: EntityRow }) {
  const state = deliveryState(row);
  return (
    <span className={`inline-flex min-w-[92px] items-center justify-center rounded border px-2 py-1 text-xs ${state.className}`}>
      {state.label}
    </span>
  );
}

function deliveryState(row: EntityRow): { label: string; className: string } {
  const start = row.adsetStartTime ?? row.startTime;
  const startMs = start ? Date.parse(start) : NaN;
  const scheduled = row.status === 'ACTIVE' && Number.isFinite(startMs) && startMs > Date.now();
  if (scheduled) {
    return {
      label: '未投放已排期',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
    };
  }
  if (row.status === 'ACTIVE' && (!row.effectiveStatus || row.effectiveStatus === 'ACTIVE')) {
    return {
      label: '投放中',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    };
  }
  if (row.status === 'ACTIVE' && row.effectiveStatus) {
    return {
      label: metaEffectiveStatusLabel(row.effectiveStatus),
      className: 'border-blue-200 bg-blue-50 text-blue-700',
    };
  }
  return {
    label: metaEntityStatusLabel(row.status),
    className: 'border-muted bg-muted/40 text-muted-foreground',
  };
}

function applyPatch<T extends EntityRow>(row: T, patch: RowPatch | undefined): T {
  return patch ? ({ ...row, ...patch } as T) : row;
}

function sortRows<T extends EntityRow>(
  rows: T[],
  insights: Record<string, InsightsSummary> | undefined,
  sort: SortState | null,
  activeFirst: boolean,
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (activeFirst) {
        const activeDiff = activeRank(a.row.status) - activeRank(b.row.status);
        if (activeDiff !== 0) return activeDiff;
      }
      if (sort) {
        const diff = compareMetric(a.row, b.row, insights, sort.metric, sort.direction);
        if (diff !== 0) return diff;
      }
      return a.index - b.index;
    })
    .map((item) => item.row);
}

function activeRank(status: EntityRow['status']): number {
  if (status === 'ACTIVE') return 0;
  if (status === 'PAUSED') return 1;
  return 2;
}

function compareMetric(
  a: EntityRow,
  b: EntityRow,
  insights: Record<string, InsightsSummary> | undefined,
  metric: SortMetric,
  direction: SortDirection,
): number {
  const ai = insights?.[a.id];
  const bi = insights?.[b.id];
  if (!ai && !bi) return 0;
  if (!ai) return 1;
  if (!bi) return -1;
  const diff = metricValue(ai, metric) - metricValue(bi, metric);
  return direction === 'asc' ? diff : -diff;
}

function metricValue(insight: InsightsSummary, metric: SortMetric): number {
  return insight[metric];
}

function summarizeInsights<T extends EntityRow>(
  rows: T[],
  insights: Record<string, InsightsSummary> | undefined,
): InsightSummaryTotal {
  const total: InsightSummaryTotal = {
    rows: rows.length,
    hasInsights: false,
    spend: 0,
    impressions: 0,
    clicks: 0,
    orders: 0,
    cpa: 0,
    cpc: 0,
    addToCart: 0,
    initiateCheckout: 0,
    cpm: 0,
    roi: 0,
    roiCount: 0,
  };
  for (const row of rows) {
    const insight = insights?.[row.id];
    if (!insight) continue;
    total.hasInsights = true;
    total.spend += insight.spend;
    total.impressions += insight.impressions;
    total.clicks += insight.clicks;
    total.orders += insight.orders;
    total.addToCart += insight.addToCart;
    total.initiateCheckout += insight.initiateCheckout;
    if (insight.roi > 0) {
      total.roi += insight.roi;
      total.roiCount += 1;
    }
  }
  total.cpa = total.orders > 0 ? total.spend / total.orders : 0;
  total.cpc = total.clicks > 0 ? total.spend / total.clicks : 0;
  total.cpm = total.impressions > 0 ? (total.spend / total.impressions) * 1000 : 0;
  total.roi = total.roiCount > 0 ? total.roi / total.roiCount : 0;
  return total;
}

function fmtSummaryMoney(value: number, currency: string | null, show: boolean): string {
  if (!show) return '-';
  return `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

function fmtSummaryNumber(value: number, show: boolean): string {
  if (!show) return '-';
  return String(Math.round(value));
}

function fmtSummaryDecimal(value: number, show: boolean): string {
  if (!show) return '-';
  return value.toFixed(2);
}

function applyBatchPatch(
  batch: BatchState,
  ids: string[],
  patchRows: (ids: string[], patch: RowPatch) => void,
) {
  if (ids.length === 0) return;
  if (batch.action.endsWith(':status')) {
    const status = batch.params['status'];
    if (status === 'ACTIVE' || status === 'PAUSED' || status === 'ARCHIVED') {
      patchRows(ids, { status });
    }
    return;
  }
  if (batch.action.endsWith(':budget')) {
    const dailyBudget = batch.params['dailyBudget'];
    if (typeof dailyBudget === 'number') patchRows(ids, { dailyBudget });
    return;
  }
  if (batch.action.endsWith(':delete')) {
    patchRows(ids, { status: 'ARCHIVED' });
  }
}

function presetLabel(preset: DatePreset): string {
  if (preset === 'today') return '今天';
  if (preset === 'yesterday') return '昨天';
  if (preset === 'last_7d') return '近 7 天';
  if (preset === 'last_30d') return '近 30 天';
  return '全部';
}
