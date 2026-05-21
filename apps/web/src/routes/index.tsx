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
import {
  accountGroupStatusLabel,
  taskStatusLabel,
} from '@/lib/labels';

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
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity className="h-4 w-4" />
            <span>总览</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">广告管理首页</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/ad-accounts">
              进入完整广告管理
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={refreshAll}>
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
          value={shortId(me.data?.companyId)}
          detail={me.data?.email ?? '加载中'}
          icon={Building2}
        />
        <Metric
          label="广告账户组"
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

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-md border bg-background">
          <div className="flex items-center justify-between gap-3 border-b p-4">
            <div>
              <h2 className="font-medium">可见广告账户组</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                点击账户组查看组内广告账户，再进入广告系列、广告组和广告。
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to="/fb-accounts">全部账户组</Link>
            </Button>
          </div>
          <div className="divide-y">
            {fbQ.isLoading && <EmptyState text="广告账户组加载中..." />}
            {!fbQ.isLoading && recentGroups.length === 0 && (
              <EmptyState text="当前没有可见广告账户组" />
            )}
            {recentGroups.map((group) => (
              <AdAccountGroupItem key={group.id} group={group} />
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <section className="rounded-md border bg-background p-4">
            <h2 className="font-medium">作用域</h2>
            <div className="mt-3 grid gap-2 text-sm">
              <SummaryRow label="角色" value={me.data?.roles.join(', ') || '-'} />
              <SummaryRow
                label="广告账户组作用域"
                value={me.data?.scope.bypass ? '全量自动授权' : `${me.data?.scope.fbAccounts.length ?? 0} 个`}
              />
              <SummaryRow
                label="广告账户作用域"
                value={
                  me.data?.scope.bypass ? '全量自动授权' : `${me.data?.scope.adAccounts.length ?? 0} 个`
                }
              />
            </div>
          </section>

          <section className="rounded-md border bg-background p-4">
            <h2 className="font-medium">账号健康</h2>
            <div className="mt-3 space-y-2 text-sm">
              <HealthLine
                ok={invalidFb === 0}
                label={invalidFb === 0 ? '广告账户组 Token 状态正常' : `${invalidFb} 个广告账户组 Token 异常`}
              />
              <HealthLine
                ok={abnormalAdAccounts === 0}
                label={
                  abnormalAdAccounts === 0
                    ? '广告账户状态正常'
                    : `${abnormalAdAccounts} 个广告账户状态异常`
                }
              />
              <HealthLine
                ok={!canManage || runningTasks === 0}
                label={canManage ? `${runningTasks} 个后台任务运行中` : '后台任务仅管理员可见'}
              />
            </div>
          </section>

          {canManage && (
            <section className="rounded-md border bg-background p-4">
              <h2 className="font-medium">最近任务</h2>
              <div className="mt-3 space-y-2">
                {(tasksQ.data ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">暂无任务记录</p>
                )}
                {(tasksQ.data ?? []).map((task) => (
                  <div key={task.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate font-mono text-xs">{task.type}</span>
                    <span className={task.status === 'success' ? 'text-emerald-600' : 'text-muted-foreground'}>
                      {taskStatusLabel(task.status)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
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
          <Button asChild variant="outline">
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
      <div className="flex items-center justify-between gap-3">
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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  );
}

function HealthLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-amber-600" />
      )}
      <span>{label}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="p-4 text-sm text-muted-foreground">{text}</div>;
}

function shortId(value: string | undefined): string {
  if (!value) return '-';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
