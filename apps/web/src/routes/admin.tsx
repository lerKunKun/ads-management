import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, getToken, type Me } from '@/lib/api';
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

export const Route = createFileRoute('/admin')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdminPage,
});

const TASK_STATUS_COLOR: Record<string, string> = {
  success: 'text-emerald-600',
  partial: 'text-amber-600',
  failed: 'text-rose-600',
  running: 'text-blue-600',
  pending: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
};

function AdminPage() {
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  return (
    <div className="space-y-10">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">系统管理</h1>
          <div className="mt-1 text-sm">
            <Link to="/admin/users" className="text-primary hover:underline">
              用户与作用域 →
            </Link>
          </div>
        </div>
        {me.data && (
          <p className="text-xs text-muted-foreground">
            当前: <b>{me.data.email}</b> · 角色: {me.data.roles.join(', ')} ·
            {me.data.scope.bypass ? ' 本公司全局可见' : ' 仅作用域内可见'}
          </p>
        )}
      </header>
      <BreakersSection />
      <TokenHealthSection />
      <TasksSection />
      <AuditSection />
    </div>
  );
}

/* ===================== Breakers ===================== */
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
        (b) =>
          (matchText(b.target, search) || matchText(b.reason, search)) &&
          (!kind || b.kind === kind),
      ),
    [data, search, kind],
  );

  return (
    <section>
      <SectionHeader
        title="熔断状态"
        right={
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            刷新
          </Button>
        }
      />
      {q.error && (
        <p className="text-sm text-destructive mb-2">{(q.error as Error).message}</p>
      )}
      {reset.error && (
        <p className="text-sm text-destructive mb-2">{(reset.error as Error).message}</p>
      )}
      <div className="mb-3">
        <SearchFilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索目标或原因…"
          filters={[
            {
              key: 'kind',
              label: '类型',
              value: kind,
              onChange: setKind,
              options: [
                { value: '', label: '全部' },
                { value: 'fb', label: 'fb' },
                { value: 'adacct', label: 'adacct' },
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
      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>类型</TableHead>
              <TableHead>目标</TableHead>
              <TableHead>原因</TableHead>
              <TableHead>剩余 TTL</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!q.isLoading && data.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  当前无开口熔断。
                </TableCell>
              </TableRow>
            )}
            {!q.isLoading && data.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  无匹配项
                </TableCell>
              </TableRow>
            )}
            {filtered.map((b) => (
              <TableRow key={b.key}>
                <TableCell>
                  <code className="text-xs">{b.kind}</code>
                </TableCell>
                <TableCell className="font-mono text-xs">{b.target}</TableCell>
                <TableCell className="text-sm">{b.reason}</TableCell>
                <TableCell className="text-sm">
                  {b.ttl < 0 ? '永久' : `${b.ttl}s`}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={reset.isPending}
                    onClick={() => {
                      if (!confirm(`重置熔断 ${b.key} ?`)) return;
                      reset.mutate([b.key]);
                    }}
                  >
                    重置
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/* ===================== Token health ===================== */
function TokenHealthSection() {
  const scan = useMutation({ mutationFn: api.scanTokenHealth });
  return (
    <section>
      <SectionHeader title="Token 健康" />
      <p className="text-sm text-muted-foreground mb-2">
        定时任务每 6h 自动扫描；这里手动触发一次，立即查看结果。
      </p>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
          {scan.isPending ? '扫描中…' : '立即扫描'}
        </Button>
        {scan.data && (
          <span className="text-sm">
            扫描 <b>{scan.data.scanned}</b> · 通知 <b>{scan.data.notified}</b>
          </span>
        )}
        {scan.error && (
          <span className="text-sm text-destructive">
            {(scan.error as Error).message}
          </span>
        )}
      </div>
    </section>
  );
}

/* ===================== Tasks ===================== */
function TasksSection() {
  const [limit, setLimit] = useState(20);
  const q = useQuery({
    queryKey: ['admin', 'tasks', limit],
    queryFn: () => api.listTasks(limit),
    refetchInterval: 5000,
  });
  const data = q.data ?? [];

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');

  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((t) => set.add(t.type));
    return [
      { value: '', label: '全部' },
      ...Array.from(set).sort().map((t) => ({ value: t, label: t })),
    ];
  }, [data]);

  const filtered = useMemo(
    () =>
      data.filter(
        (t) =>
          (matchText(t.type, search) || matchText(t.id, search)) &&
          (!status || t.status === status) &&
          (!type || t.type === type),
      ),
    [data, search, status, type],
  );

  return (
    <section>
      <SectionHeader
        title="任务历史"
        right={
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {[10, 20, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  最近 {n}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={() => q.refetch()}>
              刷新
            </Button>
          </div>
        }
      />
      {q.error && (
        <p className="text-sm text-destructive mb-2">{(q.error as Error).message}</p>
      )}
      <div className="mb-3">
        <SearchFilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索 type 或 task_id…"
          filters={[
            {
              key: 'type',
              label: 'type',
              value: type,
              onChange: setType,
              options: typeOptions,
            },
            {
              key: 'status',
              label: '状态',
              value: status,
              onChange: setStatus,
              options: [
                { value: '', label: '全部' },
                { value: 'pending', label: 'pending' },
                { value: 'running', label: 'running' },
                { value: 'partial', label: 'partial' },
                { value: 'success', label: 'success' },
                { value: 'failed', label: 'failed' },
                { value: 'cancelled', label: 'cancelled' },
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
      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>类型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>进度</TableHead>
              <TableHead>失败</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="font-mono text-xs">task_id</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!q.isLoading && data.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  无任务记录。
                </TableCell>
              </TableRow>
            )}
            {!q.isLoading && data.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  无匹配项
                </TableCell>
              </TableRow>
            )}
            {filtered.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.type}</TableCell>
                <TableCell className={TASK_STATUS_COLOR[t.status] ?? ''}>{t.status}</TableCell>
                <TableCell>
                  {t.success}/{t.total}
                </TableCell>
                <TableCell className={t.failed > 0 ? 'text-rose-600' : ''}>
                  {t.failed}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {new Date(t.createdAt).toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs">{t.id.slice(0, 8)}…</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/* ===================== Audit ===================== */
function AuditSection() {
  // action 走后端过滤(精确匹配),resource/free-text 走客户端
  const [actionFilter, setActionFilter] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'audit', actionFilter],
    queryFn: () =>
      api.listAudit({ limit: 100, ...(actionFilter ? { action: actionFilter } : {}) }),
  });
  const data = q.data ?? [];

  const [search, setSearch] = useState('');
  const filtered = useMemo(
    () =>
      data.filter(
        (a) =>
          matchText(a.action, search) ||
          matchText(a.resource, search) ||
          matchText(a.detail ? JSON.stringify(a.detail) : '', search),
      ),
    [data, search],
  );

  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((a) => set.add(a.action));
    return [
      { value: '', label: '全部 action' },
      ...Array.from(set).sort().map((v) => ({ value: v, label: v })),
    ];
  }, [data]);

  return (
    <section>
      <SectionHeader
        title="审计日志"
        right={
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            刷新
          </Button>
        }
      />
      {q.error && (
        <p className="text-sm text-destructive mb-2">{(q.error as Error).message}</p>
      )}
      <div className="mb-3">
        <SearchFilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索 action / resource / detail…"
          filters={[
            {
              key: 'action',
              label: 'action',
              value: actionFilter,
              onChange: setActionFilter,
              options: actionOptions,
            },
          ]}
          total={data.length}
          filtered={filtered.length}
          onReset={() => {
            setSearch('');
            setActionFilter('');
          }}
        />
      </div>
      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>action</TableHead>
              <TableHead>resource</TableHead>
              <TableHead>detail</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!q.isLoading && data.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  无审计记录。
                </TableCell>
              </TableRow>
            )}
            {!q.isLoading && data.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  无匹配项
                </TableCell>
              </TableRow>
            )}
            {filtered.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-xs">{a.action}</TableCell>
                <TableCell className="font-mono text-xs">{a.resource}</TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-md truncate">
                  {a.detail ? JSON.stringify(a.detail) : '-'}
                </TableCell>
                <TableCell className="text-xs">{a.ip ?? '-'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(a.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function SectionHeader({
  title,
  right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="font-medium">{title}</h2>
      {right}
    </div>
  );
}
