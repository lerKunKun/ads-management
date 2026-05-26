import { createFileRoute, redirect, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { api, getToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
  paused: 'text-amber-600',
  pending: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
};

const TERMINAL_TASK_STATUSES = new Set(['success', 'failed', 'partial', 'cancelled']);

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

      <BreakersSection />

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

function TasksSection() {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['admin', 'tasks'],
    queryFn: () => api.listTasks(200),
    refetchInterval: 2000,
  });
  const data = q.data ?? [];
  const liveTasks = data.some((task) => !isTerminalTaskStatus(task.status));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');

  useEffect(() => {
    if (!liveTasks) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [liveTasks]);

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
                { value: 'paused', label: taskStatusLabel('paused') },
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
            <TableHead>用时</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead>task_id</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.isLoading && <EmptyRow colSpan={7} text="加载中..." />}
          {!q.isLoading && filtered.length === 0 && <EmptyRow colSpan={7} text="暂无任务记录" />}
          {pager.pageItems.map((task) => (
            <TableRow
              key={task.id}
              className="cursor-pointer hover:bg-muted/40"
              onClick={() =>
                navigate({
                  to: '/admin/operations/$taskId',
                  params: { taskId: task.id },
                })
              }
            >
              <TableCell className="font-medium">{task.type}</TableCell>
              <TableCell className={TASK_STATUS_COLOR[task.status] ?? ''}>
                {taskStatusLabel(task.status)}
              </TableCell>
              <TableCell>
                <TaskProgressCell success={task.success} failed={task.failed} total={task.total} />
              </TableCell>
              <TableCell className={task.failed > 0 ? 'text-rose-600' : ''}>{task.failed}</TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatTaskDuration(task.status, task.createdAt, task.updatedAt, nowMs)}
              </TableCell>
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
    </section>
  );
}

function TaskProgressCell({
  success,
  failed,
  total,
}: {
  success: number;
  failed: number;
  total: number;
}) {
  const done = success + failed;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="min-w-[140px]">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {done}/{total}
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3">
      <h2 className="font-medium">{title}</h2>
      {right}
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
