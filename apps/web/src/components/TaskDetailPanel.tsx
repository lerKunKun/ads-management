import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type TaskLayerProgress } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/Pagination';
import { taskStatusLabel } from '@/lib/labels';

type TaskDetail = Awaited<ReturnType<typeof api.taskStatus>>;

const TASK_STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-600',
  partial: 'text-amber-600',
  failed: 'text-rose-600',
  running: 'text-blue-600',
  paused: 'text-amber-600',
  pending: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
};

const TERMINAL_TASK_STATUSES = new Set(['success', 'failed', 'partial', 'cancelled']);

export function TaskDetailPanel({
  taskId,
  detail,
  loading,
  error,
}: {
  taskId: string;
  detail: TaskDetail | null;
  loading: boolean;
  error: unknown;
}) {
  const layers = detail?.layerProgress ?? emptyLayerProgress();
  const stepTotals = layers.reduce(
    (sum, layer) => ({
      total: sum.total + layer.total,
      success: sum.success + layer.success,
      failed: sum.failed + layer.failed,
      running: sum.running + layer.running,
      pending: sum.pending + layer.pending,
    }),
    { total: 0, success: 0, failed: 0, running: 0, pending: 0 },
  );
  const displayTotal = stepTotals.total > 0 ? stepTotals.total : (detail?.total ?? 0);
  const displaySuccess = stepTotals.total > 0 ? stepTotals.success : (detail?.success ?? 0);
  const displayFailed = stepTotals.total > 0 ? stepTotals.failed : (detail?.failed ?? 0);
  const completed = displaySuccess + displayFailed;
  const pct = displayTotal ? Math.min(100, Math.round((completed / displayTotal) * 100)) : 0;
  const liveTask = detail ? !isTerminalTaskStatus(detail.status) : false;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!liveTask) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [liveTask]);

  return (
    <div className="space-y-4">
      <section className="rounded-md border bg-background p-4">
        <div className="font-mono text-xs text-muted-foreground">task: {taskId}</div>
        {detail ? (
          <>
            <div className="mt-3 grid gap-3 md:grid-cols-6">
              <TaskMetric label="类型" value={detail.type} />
              <TaskMetric
                label="状态"
                value={taskStatusLabel(detail.status)}
                className={TASK_STATUS_COLOR[detail.status] ?? ''}
              />
              <TaskMetric label="总计" value={displayTotal} />
              <TaskMetric label="成功" value={displaySuccess} className="text-emerald-700" />
              <TaskMetric
                label="失败"
                value={displayFailed}
                className={displayFailed > 0 ? 'text-rose-700' : ''}
              />
              <TaskMetric
                label="任务时间"
                value={formatTaskDuration(detail.status, detail.createdAt, detail.updatedAt, nowMs)}
              />
            </div>
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  已处理 {completed} / {displayTotal}，进度 {pct}%
                  {stepTotals.total > 0 ? `，处理中 ${stepTotals.running}，等待 ${stepTotals.pending}` : ''}
                </span>
                <span>最后更新 {formatUpdatedAt(detail.updatedAt)}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          </>
        ) : null}
        {loading && !detail && <p className="mt-3 text-sm text-muted-foreground">加载中...</p>}
        {Boolean(error) && <p className="mt-3 text-sm text-destructive">{(error as Error).message}</p>}
      </section>

      <section className="space-y-3">
        {layers.map((layer) => (
          <TaskLayerProgressRow
            key={layer.targetType}
            taskId={taskId}
            layer={layer}
            liveTask={liveTask}
          />
        ))}
      </section>

      {detail?.failures.length ? (
        <section className="rounded-md border border-rose-200 bg-rose-50 p-4">
          <h2 className="text-sm font-medium text-rose-700">失败样本</h2>
          <div className="mt-3 max-h-[360px] space-y-1 overflow-auto text-xs text-rose-700">
            {detail.failures.map((item) => (
              <div key={item.id} className="font-mono">
                {item.targetId}: {item.error ?? '-'}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function TaskMetric({
  label,
  value,
  className = '',
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate text-sm font-medium ${className}`}>{value}</div>
    </div>
  );
}

function TaskLayerProgressRow({
  taskId,
  layer,
  liveTask,
}: {
  taskId: string;
  layer: TaskLayerProgress;
  liveTask: boolean;
}) {
  const done = layer.success + layer.failed;
  const width = layer.total > 0 ? Math.min(100, Math.round((done / layer.total) * 100)) : 0;
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{layer.label}</span>
        <span className="text-muted-foreground">
          已处理 {done} / 总计 {layer.total} 条
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${width}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="text-emerald-700">成功 {layer.success}</span>
        <span className={layer.failed > 0 ? 'text-rose-700' : ''}>失败 {layer.failed}</span>
        <span>处理中 {layer.running}</span>
        <span>等待 {layer.pending}</span>
      </div>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        <TaskLayerItemDetails
          title="成功详情"
          count={layer.success}
          tone="success"
          taskId={taskId}
          targetType={layer.targetType}
          status="success"
          pagerKey={`${taskId}:${layer.targetType}:success`}
          liveTask={liveTask}
        />
        <TaskLayerItemDetails
          title="失败详情"
          count={layer.failed}
          tone="danger"
          taskId={taskId}
          targetType={layer.targetType}
          status="failed"
          pagerKey={`${taskId}:${layer.targetType}:failed`}
          liveTask={liveTask}
        />
      </div>
    </div>
  );
}

function TaskLayerItemDetails({
  title,
  count,
  tone,
  taskId,
  targetType,
  status,
  pagerKey,
  liveTask,
}: {
  title: string;
  count: number;
  tone: 'success' | 'danger';
  taskId: string;
  targetType: 'campaign' | 'adset' | 'ad';
  status: 'success' | 'failed';
  pagerKey: string;
  liveTask: boolean;
}) {
  const toneClass = tone === 'success' ? 'text-emerald-700' : 'text-rose-700';
  const pageSize = 20;
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [pagerKey]);

  const q = useQuery({
    queryKey: ['task-items', taskId, targetType, status, page, pageSize],
    queryFn: () => api.taskItems(taskId, { targetType, status, page, pageSize }),
    enabled: count > 0,
    refetchInterval: liveTask ? 2000 : false,
  });
  const items = q.data?.items ?? [];
  const total = q.data?.total ?? count;
  const pageCount = q.data?.pageCount ?? Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="rounded-md border bg-muted/20">
      <div className={`border-b px-3 py-2 text-sm font-medium ${count > 0 ? toneClass : 'text-muted-foreground'}`}>
        {title}: {count} 条
      </div>
      {count === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">暂无明细</div>
      ) : (
        <>
          {q.isLoading && <div className="px-3 py-3 text-xs text-muted-foreground">加载中...</div>}
          {q.error && <div className="px-3 py-3 text-xs text-destructive">{(q.error as Error).message}</div>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>对象 ID</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-xs">{item.targetId}</TableCell>
                  <TableCell className="break-words text-xs text-muted-foreground">
                    {item.detail ? shortDetail(item.detail) : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            page={page}
            pageCount={pageCount}
            total={total}
            pageSize={pageSize}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}

function shortDetail(value: string): string {
  if (value.length <= 260) return value;
  return `${value.slice(0, 260)}...`;
}

function formatUpdatedAt(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return new Date(value).toLocaleString();
}

function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

function formatTaskDuration(
  status: string,
  createdAt: string,
  updatedAt: number | null | undefined,
  nowMs: number,
): string {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return '-';
  const terminal = isTerminalTaskStatus(status);
  const endMs = terminal ? updatedAt : nowMs;
  if (typeof endMs !== 'number' || !Number.isFinite(endMs)) return terminal ? '完成 -' : '-';
  const seconds = Math.max(0, Math.floor((endMs - createdMs) / 1000));
  return terminal ? `完成 ${seconds} 秒` : `已用 ${seconds} 秒`;
}

function emptyLayerProgress(): TaskLayerProgress[] {
  return [
    { targetType: 'campaign', label: '广告系列', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
    { targetType: 'adset', label: '广告组', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
    { targetType: 'ad', label: '广告', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
  ];
}
