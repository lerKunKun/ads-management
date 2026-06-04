import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Tooltip } from '@/components/ui/tooltip';
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
import { PAGE_SIZE, PAGE_SIZE_OPTIONS, Pagination, usePagination } from '@/components/Pagination';
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
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
  };
  syncInfo?: {
    status: 'idle' | 'success' | 'failed' | 'syncing';
    lastSyncedAt: string | null;
    stale: boolean;
    lastError?: string | null;
  };
  serverSearch?: {
    value: string;
    onChange: (value: string) => void;
  };
  summaryOverride?: {
    label: string;
    summary: InsightSummaryTotal;
  };
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

export interface InsightSummaryTotal {
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
const ENTITY_TABLE_CLASS = 'min-w-[1220px] table-fixed text-sm lg:min-w-0';
const ENTITY_TABLE_WRAPPER_CLASS = 'max-h-[calc(100svh-320px)] overflow-x-auto overflow-y-auto overscroll-contain lg:max-h-[calc(100vh-260px)] lg:overflow-x-hidden';
const SELECT_COL_CLASS = 'w-11 px-2 py-2.5 text-center';
const SWITCH_COL_CLASS = 'w-12 px-2 py-2.5';
const NAME_COL_CLASS = 'w-72 px-2.5 py-2.5 lg:w-auto';
const STATUS_COL_CLASS = 'w-28 px-2 py-2.5';
const BUDGET_COL_CLASS = 'w-28 px-2 py-2.5';
const ACTION_COL_CLASS = 'w-36 px-2 py-2.5 text-right';
const AD_ERROR_STATUS_FILTER = 'group:AD_ERROR';
const NO_ADS_STATUS_FILTER = 'group:NO_ADS';
const CONFIGURED_STATUS_FILTER_PREFIX = 'configured:';
const EFFECTIVE_STATUS_FILTER_PREFIX = 'effective:';
const STATUS_OPTION_ACTIVE = 'group:ACTIVE';
const STATUS_OPTION_PAUSED = 'group:PAUSED';
const STATUS_OPTION_ARCHIVED = 'group:ARCHIVED';
const STATUS_OPTION_DELIVERING = 'group:DELIVERING';
const STATUS_OPTION_STOPPED = 'group:STOPPED';

function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return (TASK_TERMINAL as readonly string[]).includes(status);
}

function syncInfoText(info: {
  status: 'idle' | 'success' | 'failed' | 'syncing';
  lastSyncedAt: string | null;
  stale: boolean;
  lastError?: string | null;
}): string {
  if (info.status === 'syncing') return '数据持续同步中';
  if (info.status === 'failed') return '同步失败，当前显示本地缓存';
  if (!info.lastSyncedAt) return '暂无同步记录';
  const time = new Date(info.lastSyncedAt).toLocaleString();
  return info.stale ? `本地缓存，最后同步 ${time}` : `已同步 ${time}`;
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
  pagination,
  syncInfo,
  serverSearch,
  summaryOverride,
}: EntityListViewProps<T>) {
  const queryClient = useQueryClient();
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
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const previousKeySignature = useRef<string | null>(null);
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const selected = selectedIds ?? internalSelected;
  const selectionControlled = selectedIds !== undefined;
  const effectiveSearch = serverSearch?.value ?? search;

  function changeSearch(next: string) {
    if (serverSearch) {
      serverSearch.onChange(next);
      setActivePage(1);
      return;
    }
    setSearch(next);
  }

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
  const statusFilterOptions = useMemo(
    () => buildStatusFilterOptions(patchedRows),
    [patchedRows],
  );

  const filteredRows = useMemo(
    () =>
      patchedRows.filter(
        (row) =>
          (!serverSearch || matchText(row.name, effectiveSearch)) &&
          matchesStatusFilter(row, statusFilter),
      ),
    [effectiveSearch, patchedRows, serverSearch, statusFilter],
  );

  const sortedRows = useMemo(
    () => sortRows(filteredRows, insights, sort, activeFirst),
    [activeFirst, filteredRows, insights, sort],
  );

  const pager = usePagination(sortedRows, pageSize);
  const activePageItems = pagination ? sortedRows : pager.pageItems;
  const activePage = pagination?.page ?? pager.page;
  const activePageSize = pagination?.pageSize ?? pager.pageSize;
  const activeTotal = pagination?.total ?? sortedRows.length;
  const activePageCount = Math.max(1, Math.ceil(activeTotal / activePageSize));
  const setActivePage = pagination?.onPageChange ?? pager.setPage;
  const rowById = useMemo(
    () => new Map(patchedRows.map((row) => [row.id, row])),
    [patchedRows],
  );
  const selectablePageItems = useMemo(
    () => activePageItems.filter((row) => !isReadOnlyEntity(row)),
    [activePageItems],
  );
  const allIds = useMemo(() => selectablePageItems.map((row) => row.id), [selectablePageItems]);
  const selectedOperableIds = useMemo(
    () => Array.from(selected).filter((id) => {
      const row = rowById.get(id);
      return row && !isReadOnlyEntity(row);
    }),
    [rowById, selected],
  );
  const selectedOperableIdSet = useMemo(
    () => new Set(selectedOperableIds),
    [selectedOperableIds],
  );
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const summaryRows = useMemo(() => {
    if (selectedOperableIds.length === 0) return activePageItems;
    return patchedRows.filter((row) => selectedOperableIdSet.has(row.id));
  }, [activePageItems, patchedRows, selectedOperableIdSet, selectedOperableIds.length]);
  const summary = useMemo(
    () => summarizeInsights(summaryRows, insights),
    [insights, summaryRows],
  );
  const footerSummary = summaryOverride?.summary ?? summary;
  const footerSummaryLabel =
    summaryOverride?.label ??
    (selectedOperableIds.length > 0 ? `已选 ${summary.rows} 项` : `本页 ${summary.rows} 项`);
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
    const row = rowById.get(id);
    if (row && isReadOnlyEntity(row)) return;
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
    setActivePage(1);
  }

  function changePageSize(nextPageSize: number) {
    if (pagination) {
      pagination.onPageSizeChange(nextPageSize);
      return;
    }
    setPageSize(nextPageSize);
    setActivePage(1);
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
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && !isTerminalTaskStatus(status) ? 30000 : false;
    },
  });

  useEffect(() => {
    if (!trackedTaskId) return;
    if (trackedTask.data?.status && isTerminalTaskStatus(trackedTask.data.status)) return;
    const stream = openTaskStream(trackedTaskId);
    stream.addEventListener('progress', (event) => {
      try {
        const snap = JSON.parse((event as MessageEvent).data) as Pick<
          Awaited<ReturnType<typeof api.taskStatus>>,
          'taskId' | 'total' | 'success' | 'failed' | 'status' | 'updatedAt'
        >;
        queryClient.setQueryData<Awaited<ReturnType<typeof api.taskStatus>>>(
          ['task-status', trackedTaskId],
          (current) =>
            current
              ? {
                  ...current,
                  total: snap.total,
                  success: snap.success,
                  failed: snap.failed,
                  status: snap.status,
                  updatedAt: snap.updatedAt,
                }
              : current,
        );
        if (isTerminalTaskStatus(snap.status)) {
          stream.close();
          void queryClient.invalidateQueries({ queryKey: ['task-status', trackedTaskId] });
        }
      } catch {
        /* ignore malformed progress event */
      }
    });
    stream.onerror = () => {
      stream.close();
    };
    return () => stream.close();
  }, [queryClient, trackedTask.data?.status, trackedTaskId]);

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
    ids = selectedOperableIds,
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
    if (selectedOperableIds.length === 0) return;
    const selectedIds = selectedOperableIds;
    const copySelection: CopySelection = {
      layer,
      ids: selectedIds,
      hint: `共 ${selectedIds.length} 个来源`,
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
  const selectedCrossesFilter = selectedOperableIds.length > 0 && filteredRows.length !== rows.length;
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
          {syncInfo && (
            <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
              {syncInfoText(syncInfo)}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2 xl:items-end">
          <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">
            <label className="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-2 text-sm sm:w-auto">
              <Switch
                size="sm"
                checked={activeFirst}
                onCheckedChange={(next) => {
                  setActiveFirst(next);
                  setActivePage(1);
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
              disabled={selectedOperableIds.length === 0 || batch.isPending || !canChangeStatus}
              onClick={() => runBatch(`${layer}:status`, { status: 'PAUSED' })}
            >
              <Pause className="h-4 w-4" aria-hidden="true" />
              批量暂停
            </Button>
            <Button
              size="sm"
              className="w-full gap-1.5 sm:w-auto"
              disabled={selectedOperableIds.length === 0 || batch.isPending || !canChangeStatus}
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
                disabled={selectedOperableIds.length === 0 || batch.isPending || !canChangeBudget}
                onClick={() => setBatchBudgetOpen(true)}
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                批量改预算
              </Button>
            )}
            <Tooltip
              className="w-full sm:w-auto"
              content={`默认复制当前表已选中的${layerActionLabel}；如果三层选择构成完整系列结构，会在弹窗中显示为系列深复制。提交前需要确认。`}
            >
              <Button
                size="sm"
                variant="outline"
                className="w-full gap-1.5 sm:w-auto"
                disabled={selectedOperableIds.length === 0 || batch.isPending || !canCopy}
                onClick={batchCopyClicked}
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                批量复制
              </Button>
            </Tooltip>
            <Button
              size="sm"
              variant="destructive"
              className="w-full gap-1.5 sm:w-auto"
              disabled={selectedOperableIds.length === 0 || batch.isPending || !canDelete}
              onClick={() => {
                if (!confirm(`批量删除 ${selectedOperableIds.length} 个${layerActionLabel}？`)) return;
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
        searchValue={effectiveSearch}
        onSearchChange={changeSearch}
        searchPlaceholder={`搜索${layerLabel}名称...`}
        filters={[
          {
            key: 'status',
            label: '状态',
            value: statusFilter,
            onChange: setStatusFilter,
            options: statusFilterOptions,
          },
        ]}
        total={rows.length}
        filtered={filteredRows.length}
        onReset={() => {
          setSearch('');
          serverSearch?.onChange('');
          setActivePage(1);
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
        <Table className={ENTITY_TABLE_CLASS} wrapperClassName={ENTITY_TABLE_WRAPPER_CLASS}>
          <TableHeader className="sticky top-0 z-40 bg-background">
            <TableRow>
              <TableHead className={SELECT_COL_CLASS}>
                <label className="flex min-h-10 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    className="h-5 w-5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                    checked={allSelected}
                    disabled={allIds.length === 0}
                    onChange={toggleAll}
                    aria-label={`选择全部${layerLabel}`}
                  />
                </label>
              </TableHead>
              <TableHead className={SWITCH_COL_CLASS} />
              <TableHead className={NAME_COL_CLASS}>名称</TableHead>
              <TableHead className={STATUS_COL_CLASS}>状态</TableHead>
              {enableBudget && <TableHead className={BUDGET_COL_CLASS}>日预算</TableHead>}
              {visibleMetricColumns.map((column) => (
                <SortableMetricHead
                  key={column.metric}
                  metric={column.metric}
                  label={column.label}
                  sort={sort}
                  onSort={toggleSort}
                />
              ))}
              <TableHead className={`${ACTION_COL_CLASS} whitespace-nowrap`}>操作</TableHead>
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
            {activePageItems.map((row) => {
              const insight = insights?.[row.id];
              const readOnly = isReadOnlyEntity(row);
              const isSelected = !readOnly && selected.has(row.id);
              const drill = onRowOpen ? undefined : drillTo?.(row);
              return (
                <TableRow
                  key={row.id}
                  className={[
                    isSelected ? 'bg-muted/30' : '',
                    readOnly ? 'bg-muted/40 text-muted-foreground opacity-70' : '',
                  ].filter(Boolean).join(' ')}
                >
                  <TableCell data-label="选择" className={SELECT_COL_CLASS}>
                    <label
                      className={[
                        'flex min-h-10 items-center justify-center',
                        readOnly ? 'cursor-not-allowed' : 'cursor-pointer',
                      ].join(' ')}
                    >
                      <input
                        type="checkbox"
                        className="h-5 w-5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                        checked={isSelected}
                        disabled={readOnly}
                        onChange={() => toggle(row.id)}
                        aria-label={`选择${row.name}`}
                      />
                    </label>
                  </TableCell>
                  <TableCell data-label="开关" className={SWITCH_COL_CLASS}>
                    <Switch
                      size="sm"
                      checked={row.status === 'ACTIVE'}
                      disabled={readOnly || setStatus.isPending || !canChangeStatus}
                      onCheckedChange={() =>
                        setStatus.mutate({ id: row.id, status: statusFromSwitch(row.status) })
                      }
                      aria-label={`status-${row.id}`}
                    />
                  </TableCell>
                  <TableCell data-label="名称" className={`${NAME_COL_CLASS} font-medium`}>
                    {onRowOpen ? (
                      <button
                        type="button"
                        className={[
                          'block max-w-full whitespace-normal break-words text-left',
                          readOnly ? 'text-muted-foreground' : 'text-primary hover:underline',
                        ].join(' ')}
                        title={row.name}
                        disabled={readOnly}
                        onClick={() => onRowOpen(row)}
                      >
                        {row.name}
                      </button>
                    ) : drill && !readOnly ? (
                      <Link
                        to={drill.to}
                        params={drill.params}
                        className="block whitespace-normal break-words text-primary hover:underline"
                        title={row.name}
                      >
                        {row.name}
                      </Link>
                    ) : (
                      <span className="block whitespace-normal break-words" title={row.name}>{row.name}</span>
                    )}
                  </TableCell>
                  <TableCell data-label="状态" className={STATUS_COL_CLASS}>
                    <DeliveryStatusBadge row={row} />
                  </TableCell>
                  {enableBudget && (
                    <TableCell data-label="日预算" className={BUDGET_COL_CLASS}>
                      <button
                        type="button"
                        onClick={() =>
                          setBudgetEditing({
                            id: row.id,
                            name: row.name,
                            ...(row.dailyBudget !== undefined ? { daily: row.dailyBudget } : {}),
                          })
                        }
                        disabled={readOnly || !canChangeBudget}
                        className="block max-w-full whitespace-normal break-words text-left hover:underline disabled:opacity-50"
                      >
                        {fmtBudget(row.dailyBudget)}
                      </button>
                    </TableCell>
                  )}
                  <TableCell data-label={metricLabel('spend')} className={metricCellClass('spend')}>
                    {insight ? fmtMoney(insight.spend) : '-'}
                  </TableCell>
                  <TableCell data-label={metricLabel('orders')} className={metricCellClass('orders')}>
                    {insight ? insight.orders || '-' : '-'}
                  </TableCell>
                  <TableCell data-label={metricLabel('cpa')} className={metricCellClass('cpa')}>
                    {insight ? (insight.cpa ? fmtMoney(insight.cpa) : '-') : '-'}
                  </TableCell>
                  <TableCell data-label={metricLabel('cpc')} className={metricCellClass('cpc')}>
                    {insight ? (insight.cpc ? insight.cpc.toFixed(2) : '-') : '-'}
                  </TableCell>
                  <TableCell data-label={metricLabel('addToCart')} className={metricCellClass('addToCart')}>
                    {insight ? insight.addToCart || '-' : '-'}
                  </TableCell>
                  <TableCell data-label={metricLabel('initiateCheckout')} className={metricCellClass('initiateCheckout')}>
                    {insight ? insight.initiateCheckout || '-' : '-'}
                  </TableCell>
                  <TableCell data-label={metricLabel('cpm')} className={metricCellClass('cpm')}>
                    {insight ? (insight.cpm ? insight.cpm.toFixed(2) : '-') : '-'}
                  </TableCell>
                  <TableCell data-label={metricLabel('roi')} className={metricCellClass('roi')}>
                    {insight ? (insight.roi ? insight.roi.toFixed(2) : '-') : '-'}
                  </TableCell>
                  <TableCell data-label="操作" className={`${ACTION_COL_CLASS} whitespace-nowrap`}>
                    <div className="inline-flex items-center gap-1">
                      <Tooltip content={`只复制这一行${layerActionLabel}，不使用表格已勾选的其他对象。`}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9 px-2.5 text-sm"
                          disabled={readOnly || batch.isPending || !canCopy}
                          onClick={() => singleCopyClicked(row)}
                        >
                          复制
                        </Button>
                      </Tooltip>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-9 px-2.5 text-sm"
                        disabled={readOnly || deleteMut.isPending || !canDelete}
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
          <TableFooter className="sticky bottom-0 z-30">
            <SummaryRow
              label={footerSummaryLabel}
              summary={footerSummary}
              currency={currency ?? null}
              enableBudget={enableBudget}
            />
          </TableFooter>
        </Table>
        <Pagination
          page={activePage}
          pageCount={activePageCount}
          total={activeTotal}
          pageSize={activePageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageChange={setActivePage}
          onPageSizeChange={changePageSize}
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
        target={{ id: '_batch_', name: `批量 ${selectedOperableIds.length} 个` }}
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

function buildStatusFilterOptions(rows: EntityRow[]): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [{ value: '', label: '全部' }];
  const seenValues = new Set(options.map((option) => option.value));

  addStatusFilterOption(options, seenValues, { value: STATUS_OPTION_ACTIVE, label: '启用' });
  addStatusFilterOption(options, seenValues, { value: STATUS_OPTION_PAUSED, label: '暂停' });
  addStatusFilterOption(options, seenValues, {
    value: STATUS_OPTION_ARCHIVED,
    label: '已归档/删除',
  });
  addStatusFilterOption(options, seenValues, {
    value: AD_ERROR_STATUS_FILTER,
    label: '广告错误',
  });
  addStatusFilterOption(options, seenValues, {
    value: NO_ADS_STATUS_FILTER,
    label: '无广告',
  });
  addStatusFilterOption(options, seenValues, { value: STATUS_OPTION_DELIVERING, label: '投放中' });
  addStatusFilterOption(options, seenValues, { value: STATUS_OPTION_STOPPED, label: '已暂停' });

  const effectiveStatuses = Array.from(
    new Set(rows.map((row) => normalizeStatus(row.effectiveStatus)).filter(Boolean)),
  ).sort();
  for (const status of effectiveStatuses) {
    if (isHiddenEffectiveStatusOption(status)) continue;
    addStatusFilterOption(options, seenValues, {
      value: `${EFFECTIVE_STATUS_FILTER_PREFIX}${status}`,
      label: metaEffectiveStatusLabel(status),
    });
  }

  return options;
}

function addStatusFilterOption(
  options: Array<{ value: string; label: string }>,
  seenValues: Set<string>,
  option: { value: string; label: string },
) {
  if (seenValues.has(option.value)) return;
  seenValues.add(option.value);
  options.push(option);
}

function matchesStatusFilter(row: EntityRow, filter: string): boolean {
  if (!filter) return true;
  const effectiveStatus = normalizeStatus(row.effectiveStatus);

  if (filter.startsWith(CONFIGURED_STATUS_FILTER_PREFIX)) {
    return row.status === filter.slice(CONFIGURED_STATUS_FILTER_PREFIX.length);
  }
  if (filter.startsWith(EFFECTIVE_STATUS_FILTER_PREFIX)) {
    return effectiveStatus === filter.slice(EFFECTIVE_STATUS_FILTER_PREFIX.length);
  }
  if (filter === STATUS_OPTION_ACTIVE) {
    return row.status === 'ACTIVE';
  }
  if (filter === STATUS_OPTION_PAUSED) {
    return row.status === 'PAUSED';
  }
  if (filter === STATUS_OPTION_ARCHIVED) {
    return isArchivedOrDeletedStatus(row.status) || isArchivedOrDeletedStatus(effectiveStatus);
  }
  if (filter === AD_ERROR_STATUS_FILTER) {
    return isAdErrorEffectiveStatus(effectiveStatus);
  }
  if (filter === NO_ADS_STATUS_FILTER) {
    return isNoAdsEffectiveStatus(effectiveStatus);
  }
  if (filter === STATUS_OPTION_DELIVERING) {
    return effectiveStatus === 'ACTIVE';
  }
  if (filter === STATUS_OPTION_STOPPED) {
    return isPausedEffectiveStatus(effectiveStatus);
  }

  return row.status === filter || effectiveStatus === filter;
}

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? '').trim().toUpperCase();
}

function isReadOnlyEntity(row: EntityRow): boolean {
  const status = normalizeStatus(row.status);
  const effectiveStatus = normalizeStatus(row.effectiveStatus);
  return isArchivedOrDeletedStatus(status) || isArchivedOrDeletedStatus(effectiveStatus);
}

function isArchivedOrDeletedStatus(status: string | null | undefined): boolean {
  const normalized = normalizeStatus(status);
  return normalized === 'ARCHIVED' || normalized === 'DELETED';
}

function isPausedEffectiveStatus(status: string): boolean {
  return status === 'PAUSED' || status.includes('PAUSED');
}

function isHiddenEffectiveStatusOption(status: string): boolean {
  return (
    status === 'ACTIVE' ||
    isPausedEffectiveStatus(status) ||
    isArchivedOrDeletedStatus(status) ||
    isAdErrorEffectiveStatus(status) ||
    isNoAdsEffectiveStatus(status)
  );
}

function isAdErrorEffectiveStatus(status: string): boolean {
  return status === 'WITH_ISSUES' || status.includes('ISSUE') || status.includes('ERROR');
}

function isNoAdsEffectiveStatus(status: string): boolean {
  return (
    status === 'NO_ADS' ||
    status.includes('NO_ADS') ||
    status.includes('HAS_NO_ADS') ||
    status.includes('NO_ACTIVE_ADS')
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
    <TableHead className={`${metricCellClass(metric)} whitespace-nowrap`}>
      <button
        type="button"
        className="inline-flex min-w-0 items-center justify-end gap-1 whitespace-nowrap text-right hover:text-primary"
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

function metricCellClass(metric: SortMetric): string {
  const width =
    metric === 'spend' || metric === 'cpa'
      ? 'w-24'
      : metric === 'cpc' || metric === 'cpm'
        ? 'w-20'
        : 'w-16';
  return `${width} overflow-hidden px-2 py-2.5 text-right tabular-nums`;
}

function metricLabel(metric: SortMetric): string {
  return METRIC_COLUMNS.find((column) => column.metric === metric)?.label ?? metric;
}

const SUMMARY_CELL_CLASS = 'sticky bottom-0 z-20 whitespace-nowrap bg-[#B9DEFF]';

function SummaryRow({
  label,
  summary,
  currency,
  enableBudget,
}: {
  label: string;
  summary: InsightSummaryTotal;
  currency: string | null;
  enableBudget?: boolean;
}) {
  return (
    <TableRow className="border-t bg-[#B9DEFF] hover:bg-[#B9DEFF]">
      <TableCell className={`${SUMMARY_CELL_CLASS} ${SELECT_COL_CLASS}`} />
      <TableCell className={`${SUMMARY_CELL_CLASS} ${SWITCH_COL_CLASS}`} />
      <TableCell className={`${SUMMARY_CELL_CLASS} ${NAME_COL_CLASS} truncate font-semibold`}>
        汇总（{label}）
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} ${STATUS_COL_CLASS}`} />
      {enableBudget && <TableCell className={`${SUMMARY_CELL_CLASS} ${BUDGET_COL_CLASS}`} />}
      <TableCell data-label={metricLabel('spend')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('spend')}`}>
        {fmtSummaryMoney(summary.spend, currency, summary.hasInsights)}
      </TableCell>
      <TableCell data-label={metricLabel('orders')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('orders')}`}>
        {fmtSummaryNumber(summary.orders, summary.hasInsights)}
      </TableCell>
      <TableCell data-label={metricLabel('cpa')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('cpa')}`}>
        {fmtSummaryMoney(summary.cpa, currency, summary.hasInsights && summary.orders > 0)}
      </TableCell>
      <TableCell data-label={metricLabel('cpc')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('cpc')}`}>
        {fmtSummaryDecimal(summary.cpc, summary.hasInsights && summary.clicks > 0)}
      </TableCell>
      <TableCell data-label={metricLabel('addToCart')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('addToCart')}`}>
        {fmtSummaryNumber(summary.addToCart, summary.hasInsights)}
      </TableCell>
      <TableCell data-label={metricLabel('initiateCheckout')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('initiateCheckout')}`}>
        {fmtSummaryNumber(summary.initiateCheckout, summary.hasInsights)}
      </TableCell>
      <TableCell data-label={metricLabel('cpm')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('cpm')}`}>
        {fmtSummaryDecimal(summary.cpm, summary.hasInsights && summary.impressions > 0)}
      </TableCell>
      <TableCell data-label={metricLabel('roi')} className={`${SUMMARY_CELL_CLASS} ${metricCellClass('roi')}`}>
        {fmtSummaryDecimal(summary.roi, summary.hasInsights && summary.roiCount > 0)}
      </TableCell>
      <TableCell className={`${SUMMARY_CELL_CLASS} ${ACTION_COL_CLASS}`} />
    </TableRow>
  );
}

function DeliveryStatusBadge({ row }: { row: EntityRow }) {
  const state = deliveryState(row);
  return (
    <span className={`inline-flex w-full min-w-0 items-center justify-end rounded border px-2 py-1 text-xs sm:justify-center sm:text-sm ${state.className}`}>
      <span className="whitespace-normal break-words">{state.label}</span>
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

export function summarizeInsightValues(
  insights: Record<string, InsightsSummary> | undefined,
): InsightSummaryTotal {
  const values = Object.values(insights ?? {});
  const total = emptyInsightSummaryTotal(values.length);
  for (const insight of values) addInsightToSummary(total, insight);
  return finalizeInsightSummary(total);
}

function summarizeInsights<T extends EntityRow>(
  rows: T[],
  insights: Record<string, InsightsSummary> | undefined,
): InsightSummaryTotal {
  const total = emptyInsightSummaryTotal(rows.length);
  for (const row of rows) {
    const insight = insights?.[row.id];
    if (!insight) continue;
    addInsightToSummary(total, insight);
  }
  return finalizeInsightSummary(total);
}

function emptyInsightSummaryTotal(rows: number): InsightSummaryTotal {
  return {
    rows,
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
}

function addInsightToSummary(total: InsightSummaryTotal, insight: InsightsSummary) {
  total.hasInsights = true;
  total.spend += insight.spend;
  total.impressions += insight.impressions;
  total.clicks += insight.clicks;
  total.orders += insight.orders;
  total.addToCart += insight.addToCart;
  total.initiateCheckout += insight.initiateCheckout;
  if (insight.spend > 0) {
    total.roi += Math.max(insight.roi, 0) * insight.spend;
    total.roiCount += insight.spend;
  }
}

function finalizeInsightSummary(total: InsightSummaryTotal): InsightSummaryTotal {
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
