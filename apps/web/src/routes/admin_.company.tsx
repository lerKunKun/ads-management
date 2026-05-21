import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Building2,
  KeyRound,
  Megaphone,
  RefreshCw,
  Users,
} from 'lucide-react';
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
import {
  accountGroupStatusLabel,
  taskStatusLabel,
  userStatusLabel,
} from '@/lib/labels';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/admin_/company')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: CompanyPage,
});

function CompanyPage() {
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.listUsers });
  const resources = useQuery({
    queryKey: ['admin', 'grant-resources'],
    queryFn: api.listGrantResources,
  });
  const tasks = useQuery({
    queryKey: ['admin', 'tasks', 'company'],
    queryFn: () => api.listTasks(20),
  });

  const userRows = users.data ?? [];
  const groups = resources.data?.fbAccounts ?? [];
  const adAccounts = resources.data?.adAccounts ?? [];
  const runningTasks = (tasks.data ?? []).filter((task) =>
    ['pending', 'running'].includes(task.status),
  ).length;
  const activeUsers = userRows.filter((user) => user.status === 'active').length;
  const activeGroups = groups.filter((group) => group.status === 'active').length;
  const activeAdAccounts = adAccounts.filter((account) => account.status === 'active').length;
  const accountCountByGroup = new Map<string, number>();
  for (const account of adAccounts) {
    accountCountByGroup.set(account.fbAccountId, (accountCountByGroup.get(account.fbAccountId) ?? 0) + 1);
  }

  const error =
    (me.error as Error | null)?.message ??
    (users.error as Error | null)?.message ??
    (resources.error as Error | null)?.message ??
    (tasks.error as Error | null)?.message;

  function refreshAll() {
    me.refetch();
    users.refetch();
    resources.refetch();
    tasks.refetch();
  }

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link to="/admin" className="hover:text-foreground">
          返回管理中心
        </Link>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Building2 className="h-4 w-4" />
            <span>公司管理</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">当前公司</h1>
        </div>
        <Button size="sm" variant="outline" onClick={refreshAll}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <section className="rounded-md border bg-background p-4">
          <h2 className="font-medium">公司信息</h2>
          <div className="mt-4 grid gap-3 text-sm">
            <InfoRow label="公司 ID" value={me.data?.companyId ?? '-'} mono />
            <InfoRow label="当前用户" value={me.data?.email ?? '-'} />
            <InfoRow label="当前角色" value={me.data?.roles.join(', ') || '-'} />
            <InfoRow
              label="权限模式"
              value={me.data?.scope.bypass ? '全量自动授权' : '按账户组与广告账户授权'}
            />
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="用户" value={`${activeUsers}/${userRows.length}`} detail="正常 / 全部" icon={Users} />
          <Metric
            label="广告账户组"
            value={`${activeGroups}/${groups.length}`}
            detail="正常 / 全部"
            icon={KeyRound}
          />
          <Metric
            label="广告账户"
            value={`${activeAdAccounts}/${adAccounts.length}`}
            detail="正常 / 全部"
            icon={Megaphone}
          />
          <Metric
            label="运行中任务"
            value={String(runningTasks)}
            detail="后台任务"
            icon={Activity}
            tone={runningTasks > 0 ? 'warning' : 'default'}
          />
        </section>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <section className="overflow-hidden rounded-md border bg-background">
          <SectionTitle
            title="广告账户组"
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/fb-accounts">打开账户组</Link>
              </Button>
            }
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>广告账户</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resources.isLoading && <EmptyRow colSpan={3} text="加载中..." />}
              {!resources.isLoading && groups.length === 0 && (
                <EmptyRow colSpan={3} text="暂无广告账户组" />
              )}
              {groups.slice(0, 8).map((group) => (
                <TableRow key={group.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/fb-accounts/$id"
                      params={{ id: group.id }}
                      className="text-primary hover:underline"
                    >
                      {group.name}
                    </Link>
                  </TableCell>
                  <TableCell className={statusClass(group.status)}>
                    {accountGroupStatusLabel(group.status)}
                  </TableCell>
                  <TableCell>{accountCountByGroup.get(group.id) ?? 0}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <section className="overflow-hidden rounded-md border bg-background">
          <SectionTitle
            title="用户与任务"
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/admin/users">用户目录</Link>
              </Button>
            }
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>对象</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>附加信息</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isLoading && <EmptyRow colSpan={3} text="加载中..." />}
              {!users.isLoading && userRows.length === 0 && <EmptyRow colSpan={3} text="暂无用户" />}
              {userRows.slice(0, 6).map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.email}</TableCell>
                  <TableCell className={statusClass(user.status)}>
                    {userStatusLabel(user.status)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {user.roles.join(', ') || '-'} / 作用域 {user.grantsCount}
                  </TableCell>
                </TableRow>
              ))}
              {(tasks.data ?? []).slice(0, 4).map((task) => (
                <TableRow key={task.id}>
                  <TableCell className="font-mono text-xs">{task.type}</TableCell>
                  <TableCell className={statusClass(task.status)}>
                    {taskStatusLabel(task.status)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {task.success}/{task.total} 成功，失败 {task.failed}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className={cn('h-4 w-4', tone === 'warning' ? 'text-amber-600' : 'text-muted-foreground')} />
      </div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b pb-2 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right font-medium', mono && 'font-mono text-xs')}>
        {value}
      </span>
    </div>
  );
}

function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b p-3">
      <h2 className="font-medium">{title}</h2>
      {action}
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

function statusClass(status: string): string {
  if (['active', 'success'].includes(status)) return 'text-emerald-600';
  if (['pending', 'running', 'partial'].includes(status)) return 'text-amber-600';
  if (['disabled', 'closed', 'token_invalid', 'failed'].includes(status)) return 'text-rose-600';
  return 'text-muted-foreground';
}
