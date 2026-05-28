import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  KeyRound,
  Megaphone,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { api, getToken, type FbAccount, type Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { accountGroupStatusLabel } from '@/lib/labels';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: DashboardPage,
});

function DashboardPage() {
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const fbQ = useQuery({ queryKey: ['fb-accounts'], queryFn: api.fbAccounts });
  const adAccountsQ = useQuery({ queryKey: ['ad-accounts'], queryFn: () => api.adAccounts() });
  const canManage = me.data?.permissions.includes('iam:manage') ?? false;
  const tasksQ = useQuery({
    queryKey: ['admin', 'tasks', 'home'],
    queryFn: () => api.listTasks(5),
    enabled: canManage,
  });

  const fbAccounts = fbQ.data ?? [];
  const adAccounts = adAccountsQ.data ?? [];
  const activeFb = fbAccounts.filter((item) => item.status === 'active').length;
  const invalidFb = fbAccounts.filter((item) => item.status === 'token_invalid').length;
  const activeAdAccounts = adAccounts.filter((item) => item.status === 'active').length;
  const abnormalAdAccounts = adAccounts.length - activeAdAccounts;
  const recentGroups = fbAccounts.slice(0, 8);
  const runningTasks = (tasksQ.data ?? []).filter((task) =>
    ['pending', 'running'].includes(task.status),
  ).length;

  const error =
    (me.error as Error | null)?.message ??
    (fbQ.error as Error | null)?.message ??
    (adAccountsQ.error as Error | null)?.message ??
    (tasksQ.error as Error | null)?.message;

  function refreshAll() {
    me.refetch();
    fbQ.refetch();
    adAccountsQ.refetch();
    if (canManage) tasksQ.refetch();
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4" />
            <span>总览</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">广告管理首页</h1>
        </div>
        <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          <Button asChild className="w-full sm:w-auto">
            <Link to="/ad-accounts">
              进入完整广告管理
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={refreshAll}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="当前公司"
          value={me.data?.companyName ?? '-'}
          detail={me.data?.email ?? '加载中'}
          icon={Building2}
        />
        <Metric
          label="FB个人号"
          value={String(fbAccounts.length)}
          detail={`正常 ${activeFb} / 异常 ${invalidFb}`}
          icon={KeyRound}
          tone={invalidFb > 0 ? 'warning' : 'default'}
        />
        <Metric
          label="广告账户"
          value={String(adAccounts.length)}
          detail={`可用 ${activeAdAccounts} / 异常 ${abnormalAdAccounts}`}
          icon={Megaphone}
          tone={abnormalAdAccounts > 0 ? 'warning' : 'default'}
        />
        <Metric
          label="后台任务"
          value={canManage ? String(runningTasks) : '-'}
          detail={canManage ? '运行中任务' : '无管理权限'}
          icon={ShieldCheck}
        />
      </section>

      <section className="grid gap-4">
        <section className="rounded-md border bg-background">
          <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="font-medium">可见FB个人号</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                点击FB个人号查看其下广告账户，再进入广告系列、广告组和广告。
              </p>
            </div>
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <Link to="/fb-accounts">全部FB个人号</Link>
            </Button>
          </div>
          <div className="divide-y">
            {fbQ.isLoading && <EmptyState text="FB个人号加载中..." />}
            {!fbQ.isLoading && recentGroups.length === 0 && (
              <EmptyState text="当前没有可见FB个人号" />
            )}
            {recentGroups.map((group) => (
              <AdAccountGroupItem key={group.id} group={group} />
            ))}
          </div>
        </section>
      </section>

      <section className="rounded-md border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">广告操作入口</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              完整管理页按广告账户进入，后续页面通过点击名称逐级打开广告系列、广告组、广告。
            </p>
          </div>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link to="/ad-accounts">
              打开广告账户列表
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
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
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className={cn('h-4 w-4', tone === 'warning' ? 'text-amber-600' : 'text-muted-foreground')} />
      </div>
      <div className="mt-3 truncate text-2xl font-semibold">{value}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function AdAccountGroupItem({ group }: { group: FbAccount }) {
  return (
    <Link
      to="/fb-accounts/$id"
      params={{ id: group.id }}
      className="grid gap-2 px-4 py-3 transition-colors hover:bg-muted/40 md:grid-cols-[1fr_auto]"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{group.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{group.fbUserId}</span>
          <span>{group.adAccountCount} 个广告账户</span>
        </div>
      </div>
      <StatusBadge status={group.status} />
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const active = status === 'active';
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded border px-2 py-1 text-xs',
        active
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-amber-200 bg-amber-50 text-amber-700',
      )}
    >
      {active ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {accountGroupStatusLabel(status)}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="p-4 text-sm text-muted-foreground">{text}</div>;
}
