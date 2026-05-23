import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Activity, DatabaseZap, RefreshCw } from 'lucide-react';
import { api, getToken, type TaskLayerProgress, type TaskLayerProgressItem } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';
import { Pagination, usePagination } from '@/components/Pagination';
import { breakerKindLabel, taskStatusLabel } from '@/lib/labels';

type SyncDepth = 'campaign' | 'adset' | 'ad';
type SyncArgs = NonNullable<Parameters<typeof api.syncAdObjects>[0]>;
type SyncResult = Awaited<ReturnType<typeof api.syncAdObjects>>;

export const Route = createFileRoute('/admin_/operations')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: OperationsPage,
});

const TASK_STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-600',
  partial: 'text-amber-600',
  failed: 'text-rose-600',
  running: 'text-blue-600',
  pending: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
};

const depthOptions: Array<{ value: SyncDepth; label: string }> = [
  { value: 'campaign', label: '广告系列' },
  { value: 'adset', label: '广告系列 + 广告组' },
  { value: 'ad', label: '广告系列 + 广告组 + 广告' },
];

function OperationsPage() {
  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link to="/admin" className="hover:text-foreground">
          返回管理中心
        </Link>
      </div>

      <header>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="h-4 w-4" />
          <span>系统运行</span>
        </div>
        <h1 className="mt-1 text-xl font-semibold">运行状态</h1>
      </header>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <BreakersSection />
        <div className="space-y-6">
          <TokenHealthSection />
          <AdObjectSyncSection />
        </div>
      </div>

      <TasksSection />
    </div>
  );
}

function BreakersSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'breakers'], queryFn: api.listBreakers });
  const reset = useMutation({
    mutationFn: (keys: string[]) => api.resetBreakers(keys),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'breakers'] }),
  });
  const data = q.data ?? [];
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');

  const filtered = useMemo(
    () =>
      data.filter(
        (breaker) =>
          (matchText(breaker.target, search) || matchText(breaker.reason, search)) &&
          (!kind || breaker.kind === kind),
      ),
    [data, kind, search],
  );
  const pager = usePagination(filtered, 10);

  return (
    <section className="overflow-hidden rounded-md border bg-background">
      <SectionHeader
        title="熔断状态"
        right={
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        }
      />
      {(q.error || reset.error) && (
        <p className="px-3 pb-2 text-sm text-destructive">
          {((q.error as Error) || (reset.error as Error)).message}
        </p>
      )}
      <div className="border-b px-3 pb-3">
        <SearchFilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索目标或原因"
          filters={[
            {
              key: 'kind',
              label: '类型',
              value: kind,
              onChange: setKind,
              options: [
                { value: '', label: '全部' },
                { value: 'fb', label: breakerKindLabel('fb') },
                { value: 'adacct', label: breakerKindLabel('adacct') },
              ],
            },
          ]}
          total={data.length}
          filtered={filtered.length}
          onReset={() => {
            setSearch('');
            setKind('');
          }}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>类型</TableHead>
            <TableHead>目标</TableHead>
            <TableHead>原因</TableHead>
            <TableHead>TTL</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.isLoading && <EmptyRow colSpan={5} text="加载中..." />}
          {!q.isLoading && filtered.length === 0 && <EmptyRow colSpan={5} text="暂无熔断记录" />}
          {pager.pageItems.map((breaker) => (
            <TableRow key={breaker.key}>
              <TableCell>
                <code className="text-xs">{breakerKindLabel(breaker.kind)}</code>
              </TableCell>
              <TableCell className="font-mono text-xs">{breaker.target}</TableCell>
              <TableCell className="text-sm">{breaker.reason}</TableCell>
              <TableCell className="text-sm">
                {breaker.ttl < 0 ? '永久' : `${breaker.ttl}s`}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={reset.isPending}
                  onClick={() => {
                    if (!confirm(`重置熔断 ${breaker.key} ?`)) return;
                    reset.mutate([breaker.key]);
                  }}
                >
                  重置
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination
        page={pager.page}
        pageCount={pager.pageCount}
        total={filtered.length}
        pageSize={pager.pageSize}
        onPageChange={pager.setPage}
      />
    </section>
  );
}

function TokenHealthSection() {
  const scan = useMutation({ mutationFn: api.scanTokenHealth });
  return (
    <section className="rounded-md border bg-background p-4">
      <SectionTitle icon={<RefreshCw className="h-4 w-4" />} title="Token 健康" />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? '扫描中...' : '立即扫描'}
        </Button>
        {scan.data && (
          <span className="text-sm">
            已扫描 <b>{scan.data.scanned}</b>，通知 <b>{scan.data.notified}</b>
          </span>
        )}
        {scan.error && (
          <span className="text-sm text-destructive">{(scan.error as Error).message}</span>
        )}
      </div>
    </section>
  );
}

function AdObjectSyncSection() {
  const [depth, setDepth] = useState<SyncDepth>('campaign');
  const [limit, setLimit] = useState(2);
  const [adAccountId, setAdAccountId] = useState('');
  const sync = useMutation({ mutationFn: (args: SyncArgs) => api.syncAdObjects(args) });

  const runDueSync = () => sync.mutate({ depth, limit });
  const runSingleSync = () => {
    const id = adAccountId.trim();
    if (!id) return;
    sync.mutate({ depth, adAccountId: id });
  };

  return (
    <section className="rounded-md border bg-background p-4">
      <SectionTitle icon={<DatabaseZap className="h-4 w-4" />} title="广告对象同步" />

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5 text-sm">
          <span className="text-xs text-muted-foreground">同步深度</span>
          <select
            value={depth}
            onChange={(event) => setDepth(event.target.value as SyncDepth)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {depthOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5 text-sm">
          <span className="text-xs text-muted-foreground">到期账户上限</span>
          <Input
            type="number"
            min={1}
            max={20}
            value={limit}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              setLimit(Number.isFinite(next) ? Math.min(Math.max(next, 1), 20) : 1);
            }}
          />
        </label>
      </div>

      <label className="mt-3 block space-y-1.5 text-sm">
        <span className="text-xs text-muted-foreground">指定广告账户 ID</span>
        <Input
          value={adAccountId}
          onChange={(event) => setAdAccountId(event.currentTarget.value)}
          placeholder="UUID，可留空"
        />
      </label>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={runDueSync} disabled={sync.isPending}>
          {sync.isPending ? '同步中...' : '同步到期账户'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={runSingleSync}
          disabled={sync.isPending || !adAccountId.trim()}
        >
          同步指定账户
        </Button>
      </div>

      {sync.error && (
        <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {(sync.error as Error).message}
        </p>
      )}
      {sync.data && <SyncResultView result={sync.data} />}
    </section>
  );
}

function SyncResultView({ result }: { result: SyncResult }) {
  if ('candidates' in result) {
    return (
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
        <ResultMetric label="候选" value={result.candidates} />
        <ResultMetric label="成功" value={result.synced} tone="success" />
        <ResultMetric label="跳过" value={result.skipped} />
        <ResultMetric label="失败" value={result.failed} tone={result.failed > 0 ? 'danger' : 'default'} />
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="font-medium">{result.metaActId}</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <ResultMetric label="广告系列" value={result.campaigns} />
        <ResultMetric label="广告组" value={result.adsets} />
        <ResultMetric label="广告" value={result.ads} />
      </div>
    </div>
  );
}

function ResultMetric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'danger';
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-700' : tone === 'danger' ? 'text-rose-700' : '';
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function TasksSection() {
  const q = useQuery({
    queryKey: ['admin', 'tasks'],
    queryFn: () => api.listTasks(200),
    refetchInterval: 5000,
  });
  const data = q.data ?? [];
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const taskDetail = useQuery({
    queryKey: ['admin', 'task-detail', selectedTaskId],
    queryFn: () => api.taskStatus(selectedTaskId!),
    enabled: !!selectedTaskId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'running' || status === 'pending' ? 2000 : false;
    },
  });

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((task) => set.add(task.type));
    return [
      { value: '', label: '全部' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: value })),
    ];
  }, [data]);

  const filtered = useMemo(
    () =>
      data.filter(
        (task) =>
          (matchText(task.type, search) || matchText(task.id, search)) &&
          (!status || task.status === status) &&
          (!type || task.type === type),
      ),
    [data, search, status, type],
  );
  const pager = usePagination(filtered);

  return (
    <section className="overflow-hidden rounded-md border bg-background">
      <SectionHeader
        title="任务历史"
        right={
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        }
      />
      {q.error && <p className="px-3 pb-2 text-sm text-destructive">{(q.error as Error).message}</p>}
      <div className="border-b px-3 pb-3">
        <SearchFilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索 type 或 task_id"
          filters={[
            { key: 'type', label: 'type', value: type, onChange: setType, options: typeOptions },
            {
              key: 'status',
              label: '状态',
              value: status,
              onChange: setStatus,
              options: [
                { value: '', label: '全部' },
                { value: 'pending', label: taskStatusLabel('pending') },
                { value: 'running', label: taskStatusLabel('running') },
                { value: 'partial', label: taskStatusLabel('partial') },
                { value: 'success', label: taskStatusLabel('success') },
                { value: 'failed', label: taskStatusLabel('failed') },
                { value: 'cancelled', label: taskStatusLabel('cancelled') },
              ],
            },
          ]}
          total={data.length}
          filtered={filtered.length}
          onReset={() => {
            setSearch('');
            setStatus('');
            setType('');
          }}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>类型</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>进度</TableHead>
            <TableHead>失败</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead>task_id</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.isLoading && <EmptyRow colSpan={6} text="加载中..." />}
          {!q.isLoading && filtered.length === 0 && <EmptyRow colSpan={6} text="暂无任务记录" />}
          {pager.pageItems.map((task) => (
            <TableRow
              key={task.id}
              className="cursor-pointer hover:bg-muted/40"
              onClick={() => setSelectedTaskId(task.id)}
            >
              <TableCell className="font-medium">{task.type}</TableCell>
              <TableCell className={TASK_STATUS_COLOR[task.status] ?? ''}>
                {taskStatusLabel(task.status)}
              </TableCell>
              <TableCell>
                {task.success}/{task.total}
              </TableCell>
              <TableCell className={task.failed > 0 ? 'text-rose-600' : ''}>{task.failed}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(task.createdAt).toLocaleString()}
              </TableCell>
              <TableCell className="font-mono text-xs">{task.id.slice(0, 8)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination
        page={pager.page}
        pageCount={pager.pageCount}
        total={filtered.length}
        onPageChange={pager.setPage}
      />
      <TaskDetailDialog
        taskId={selectedTaskId}
        detail={taskDetail.data ?? null}
        loading={taskDetail.isLoading || taskDetail.isFetching}
        error={taskDetail.error}
        onClose={() => setSelectedTaskId(null)}
      />
    </section>
  );
}

function TaskDetailDialog({
  taskId,
  detail,
  loading,
  error,
  onClose,
}: {
  taskId: string | null;
  detail: Awaited<ReturnType<typeof api.taskStatus>> | null;
  loading: boolean;
  error: unknown;
  onClose: () => void;
}) {
  if (!taskId) return null;
  const layers = detail?.layerProgress ?? emptyLayerProgress();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="任务进度">
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <div className="font-mono text-muted-foreground">task: {taskId}</div>
          {detail && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>{detail.type}</span>
              <span className={TASK_STATUS_COLOR[detail.status] ?? ''}>
                {taskStatusLabel(detail.status)}
              </span>
              <span>
                成功 {detail.success} / 总计 {detail.total}
              </span>
              <span className={detail.failed > 0 ? 'text-rose-600' : ''}>
                失败 {detail.failed}
              </span>
            </div>
          )}
        </div>

        {loading && !detail && <p className="text-sm text-muted-foreground">加载中...</p>}
        {Boolean(error) && <p className="text-sm text-destructive">{(error as Error).message}</p>}

        <div className="space-y-2">
          {layers.map((layer) => (
            <TaskLayerProgressRow key={layer.targetType} layer={layer} />
          ))}
        </div>

        {detail?.failures.length ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3">
            <div className="text-sm font-medium text-rose-700">失败样本</div>
            <div className="mt-2 max-h-36 space-y-1 overflow-auto text-xs text-rose-700">
              {detail.failures.map((item) => (
                <div key={item.id} className="font-mono">
                  {item.targetId}: {item.error ?? '-'}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button onClick={onClose}>关闭</Button>
      </DialogFooter>
    </Dialog>
  );
}

function TaskLayerProgressRow({ layer }: { layer: TaskLayerProgress }) {
  const done = layer.success + layer.failed;
  const active = layer.running + layer.pending;
  const width = layer.total > 0 ? Math.min(100, Math.round((done / layer.total) * 100)) : 0;
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{layer.label}</span>
        <span className="text-muted-foreground">
          已处理 {done} / 总计 {layer.total} 条
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${width}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="text-emerald-700">成功 {layer.success}</span>
        <span className={layer.failed > 0 ? 'text-rose-700' : ''}>失败 {layer.failed}</span>
        <span>处理中 {active}</span>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <TaskLayerItemDetails
          title="成功详情"
          count={layer.success}
          items={layer.successItems}
          tone="success"
        />
        <TaskLayerItemDetails
          title="失败详情"
          count={layer.failed}
          items={layer.failedItems}
          tone="danger"
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
}: {
  title: string;
  count: number;
  items: TaskLayerProgressItem[];
  tone: 'success' | 'danger';
}) {
  const toneClass = tone === 'success' ? 'text-emerald-700' : 'text-rose-700';
  const pager = usePagination(items, 20);
  return (
    <details className="rounded border bg-muted/20 p-2" open={count > 0}>
      <summary className={`cursor-pointer text-xs font-medium ${count > 0 ? toneClass : 'text-muted-foreground'}`}>
        {title}：{count} 条
      </summary>
      <div className="mt-2 overflow-hidden rounded-md border bg-background">
        {items.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">暂无明细</div>
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
    </details>
  );
}

function shortDetail(value: string): string {
  if (value.length <= 180) return value;
  return `${value.slice(0, 180)}...`;
}

function emptyLayerProgress(): TaskLayerProgress[] {
  return [
    { targetType: 'campaign', label: '广告系列', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
    { targetType: 'adset', label: '广告组', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
    { targetType: 'ad', label: '广告', total: 0, success: 0, failed: 0, running: 0, pending: 0, successItems: [], failedItems: [] },
  ];
}

function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3">
      <h2 className="font-medium">{title}</h2>
      {right}
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 font-medium">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}
