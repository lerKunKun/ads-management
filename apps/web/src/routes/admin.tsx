import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Building2,
  ClipboardList,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api, getToken, type Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/admin')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdminPage,
});

type AdminMenuPath =
  | '/admin/company'
  | '/admin/iam'
  | '/admin/users'
  | '/admin/operations'
  | '/admin/audit'
  | '/admin/announcements';

const adminMenus: Array<{
  title: string;
  description: string;
  to: AdminMenuPath;
  icon: LucideIcon;
  platformOnly?: boolean;
}> = [
  {
    title: '公司管理',
    description: '查看当前公司、用户规模、FB个人号和广告账户资产概况。',
    to: '/admin/company',
    icon: Building2,
  },
  {
    title: 'IAM 权限工作台',
    description: '按用户、FB个人号、广告账户三栏联动分配权限。',
    to: '/admin/iam',
    icon: ShieldCheck,
  },
  {
    title: '用户目录',
    description: '创建用户、调整角色和启停账号。',
    to: '/admin/users',
    icon: Users,
  },
  {
    title: '系统运行',
    description: '查看熔断、Token 健康、后台任务和同步状态。',
    to: '/admin/operations',
    icon: Activity,
  },
  {
    title: '审计日志',
    description: '按 action、resource 和关键字检索操作记录。',
    to: '/admin/audit',
    icon: ClipboardList,
  },
  {
    title: '站内信发布',
    description: '发布站内信，管理通知正文、标识和计划时间。',
    to: '/admin/announcements',
    icon: Megaphone,
    platformOnly: true,
  },
];

function AdminPage() {
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const companies = useQuery({ queryKey: ['admin', 'companies'], queryFn: api.listCompanies });
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: api.listUsers });
  const resources = useQuery({
    queryKey: ['admin', 'grant-resources'],
    queryFn: api.listGrantResources,
  });
  const breakers = useQuery({ queryKey: ['admin', 'breakers'], queryFn: api.listBreakers });
  const tasks = useQuery({
    queryKey: ['admin', 'tasks', 'snapshot'],
    queryFn: () => api.listTasks(20),
  });

  const activeUsers = (users.data ?? []).filter((user) => user.status === 'active').length;
  const adAccounts = resources.data?.adAccounts.length ?? 0;
  const fbAccounts = resources.data?.fbAccounts.length ?? 0;
  const runningTasks = (tasks.data ?? []).filter((task) =>
    ['pending', 'running'].includes(task.status),
  ).length;
  const currentCompanyName =
    companies.data?.find((company) => company.id === me.data?.companyId)?.name ??
    me.data?.companyName ??
    me.data?.companyId ??
    '-';
  const isPlatformAdmin = me.data?.roles.includes('PlatformAdmin') ?? false;
  const visibleMenus = adminMenus.filter((item) => !item.platformOnly || isPlatformAdmin);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LayoutDashboard className="h-4 w-4" />
            <span>管理中心</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">后台管理</h1>
        </div>
        {me.data && (
          <div className="max-w-full break-words rounded-md border px-3 py-2 text-xs text-muted-foreground sm:max-w-[32rem]">
            当前公司 <b className="text-foreground">{currentCompanyName}</b>
            <span className="mx-2">/</span>
            当前用户 <b className="text-foreground">{me.data.email}</b>
          </div>
        )}
      </header>

      {(users.error || resources.error || breakers.error || tasks.error) && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {(
            (users.error as Error) ||
            (resources.error as Error) ||
            (breakers.error as Error) ||
            (tasks.error as Error)
          ).message}
        </p>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="活跃用户" value={activeUsers} icon={Users} />
        <Metric label="FB个人号" value={fbAccounts} icon={KeyRound} />
        <Metric label="广告账户" value={adAccounts} icon={ShieldCheck} />
        <Metric
          label="运行中任务"
          value={runningTasks}
          icon={Activity}
          tone={runningTasks > 0 ? 'warning' : 'default'}
        />
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {visibleMenus.map((item) => (
          <AdminMenuCard key={item.to} item={item} />
        ))}
      </section>

      <section className="rounded-md border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">待关注事项</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              熔断 {breakers.data?.length ?? 0} 个，最近任务 {tasks.data?.length ?? 0} 条。
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/operations">查看运行状态</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon
          className={cn(
            'h-4 w-4',
            tone === 'warning' ? 'text-amber-600' : 'text-muted-foreground',
          )}
        />
      </div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function AdminMenuCard({
  item,
}: {
  item: {
    title: string;
    description: string;
    to: AdminMenuPath;
    icon: LucideIcon;
  };
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className="group rounded-md border bg-background p-4 transition-colors hover:border-primary/50 hover:bg-muted/30"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-primary" />
            <h2 className="font-medium">{item.title}</h2>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{item.description}</p>
        </div>
        <span className="text-sm text-muted-foreground group-hover:text-foreground">进入</span>
      </div>
    </Link>
  );
}
