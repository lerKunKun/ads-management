import type { ReactNode } from 'react';
import { api, type TaskLayerProgress, type TaskLayerProgressItem } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination, usePagination } from '@/components/Pagination';
import { taskStatusLabel } from '@/lib/labels';

type TaskDetail = Awaited<ReturnType<typeof api.taskStatus>>;

const TASK_STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-600',
  partial: 'text-amber-600',
  failed: 'text-rose-600',
  running: 'text-blue-600',
  pending: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
};

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
  const completed = detail ? detail.success + detail.failed : 0;
  const pct = detail?.total ? Math.min(100, Math.round((completed / detail.total) * 100)) : 0;

  return (
    <div className="space-y-4">
      <section className="rounded-md border bg-background p-4">
        <div className="font-mono text-xs text-muted-foreground">task: {taskId}</div>
        {detail ? (
          <>
            <div className="mt-3 grid gap-3 md:grid-cols-5">
              <TaskMetric label="类型" value={detail.type} />
              <TaskMetric
                label="状态"
                value={taskStatusLabel(detail.status)}
                className={TASK_STATUS_COLOR[detail.status] ?? ''}
              />
              <TaskMetric label="总计" value={detail.total} />
              <TaskMetric label="成功" value={detail.success} className="text-emerald-700" />
              <TaskMetric
                label="失败"
                value={detail.failed}
                className={detail.failed > 0 ? 'text-rose-700' : ''}
              />
            </div>
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  已处理 {completed} / {detail.total}，进度 {pct}%
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
          <TaskLayerProgressRow key={layer.targetType} taskId={taskId} layer={layer} />
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
}: {
  taskId: string;
  layer: TaskLayerProgress;
}) {
  const done = layer.success + layer.failed;
  const active = layer.running + layer.pending;
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
        <span>处理中 {active}</span>
      </div>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        <TaskLayerItemDetails
          title="成功详情"
          count={layer.success}
          items={layer.successItems}
          tone="success"
          pagerKey={`${taskId}:${layer.targetType}:success`}
        />
        <TaskLayerItemDetails
          title="失败详情"
          count={layer.failed}
          items={layer.failedItems}
          tone="danger"
          pagerKey={`${taskId}:${layer.targetType}:failed`}
        />
      </div>
    </div>
  );
}

function TaskLayerItemDetails({
  title,
  count,
  items,
  tone,
  pagerKey,
}: {
  title: string;
  count: number;
  items: TaskLayerProgressItem[];
  tone: 'success' | 'danger';
  pagerKey: string;
}) {
  const toneClass = tone === 'success' ? 'text-emerald-700' : 'text-rose-700';
  const pager = usePagination(items, 20, pagerKey);
  return (
    <div className="rounded-md border bg-muted/20">
      <div className={`border-b px-3 py-2 text-sm font-medium ${count > 0 ? toneClass : 'text-muted-foreground'}`}>
        {title}: {count} 条
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">暂无明细</div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>对象 ID</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pager.pageItems.map((item) => (
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
            page={pager.page}
            pageCount={pager.pageCount}
            total={items.length}
            pageSize={pager.pageSize}
            onPageChange={pager.setPage}
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

function emptyLayerProgress(): TaskLayerProgress[] {
  return [
    { targetType: 'campaign', label: '广告系列', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
    { targetType: 'adset', label: '广告组', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
    { targetType: 'ad', label: '广告', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
  ];
}
