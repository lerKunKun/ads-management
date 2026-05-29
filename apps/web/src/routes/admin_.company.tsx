import { createFileRoute, redirect, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Building2,
  KeyRound,
  Megaphone,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api, getToken, setToken, type Company, type Me } from '@/lib/api';
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
import { companyStatusLabel, userStatusLabel } from '@/lib/labels';

export const Route = createFileRoute('/admin_/company')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: CompanyPage,
});

function CompanyPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const companiesQ = useQuery({ queryKey: ['admin', 'companies'], queryFn: api.listCompanies });
  const isPlatformAdmin = me.data?.roles.includes('PlatformAdmin') ?? false;

  const companies = companiesQ.data ?? [];
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const selectedCompany =
    companies.find((company) => company.id === selectedCompanyId) ??
    companies.find((company) => company.id === me.data?.companyId) ??
    companies[0] ??
    null;

  const usersQ = useQuery({
    queryKey: ['admin', 'company-users', selectedCompany?.id ?? 'none'],
    queryFn: () => api.listCompanyUsers(selectedCompany!.id),
    enabled: !!selectedCompany,
  });

  const [createCompanyOpen, setCreateCompanyOpen] = useState(false);
  const [editCompany, setEditCompany] = useState<Company | null>(null);

  useEffect(() => {
    if (!me.data || companies.length === 0) return;
    if (!selectedCompanyId || !companies.some((company) => company.id === selectedCompanyId)) {
      setSelectedCompanyId(me.data.companyId);
    }
  }, [companies, me.data, selectedCompanyId]);

  const totals = useMemo(
    () => ({
      users: companies.reduce((sum, company) => sum + company.userCount, 0),
      groups: companies.reduce((sum, company) => sum + company.accountGroupCount, 0),
      adAccounts: companies.reduce((sum, company) => sum + company.adAccountCount, 0),
    }),
    [companies],
  );

  const createCompany = useMutation({
    mutationFn: (name: string) => api.createCompany(name),
    onSuccess: (result) => {
      setCreateCompanyOpen(false);
      setSelectedCompanyId(result.id);
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
    },
  });

  const updateCompany = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateCompany(id, { name }),
    onSuccess: () => {
      setEditCompany(null);
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
    },
  });

  const switchCompany = useMutation({
    mutationFn: (companyId: string) => api.switchCompany(companyId),
    onSuccess: (result) => {
      setToken(result.token);
      qc.clear();
    },
  });

  const error =
    (me.error as Error | null)?.message ??
    (companiesQ.error as Error | null)?.message ??
    (usersQ.error as Error | null)?.message ??
    (createCompany.error as Error | null)?.message ??
    (updateCompany.error as Error | null)?.message ??
    (switchCompany.error as Error | null)?.message;

  function refreshAll() {
    me.refetch();
    companiesQ.refetch();
    usersQ.refetch();
  }

  async function goIam(companyId: string) {
    if (isPlatformAdmin && me.data?.companyId !== companyId) {
      const result = await switchCompany.mutateAsync(companyId);
      setToken(result.token);
      qc.clear();
    }
    navigate({ to: '/admin/iam', search: {} });
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
          <h1 className="mt-1 text-xl font-semibold">
            {isPlatformAdmin ? '全部公司' : '当前公司'}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {isPlatformAdmin && (
            <Button size="sm" onClick={() => setCreateCompanyOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              新增公司
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={refreshAll}>
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
        <Metric label="公司" value={String(companies.length)} detail="可管理公司" icon={Building2} />
        <Metric label="人员" value={String(totals.users)} detail="全部公司人员" icon={Users} />
        <Metric label="FB个人号" value={String(totals.groups)} detail="全部FB个人号" icon={KeyRound} />
        <Metric label="广告账户" value={String(totals.adAccounts)} detail="全部广告账户" icon={Megaphone} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <section className="overflow-hidden rounded-md border bg-background">
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <h2 className="font-medium">公司列表</h2>
            <span className="text-xs text-muted-foreground">
              {isPlatformAdmin ? '平台管理员可切换公司' : '仅可查看当前公司'}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>公司</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>人员</TableHead>
                <TableHead>资产</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companiesQ.isLoading && <EmptyRow colSpan={5} text="加载中..." />}
              {!companiesQ.isLoading && companies.length === 0 && (
                <EmptyRow colSpan={5} text="暂无公司" />
              )}
              {companies.map((company) => (
                <TableRow
                  key={company.id}
                  className={selectedCompany?.id === company.id ? 'bg-muted/30' : ''}
                >
                  <TableCell>
                    <button
                      type="button"
                      className="text-left font-medium hover:underline"
                      onClick={() => setSelectedCompanyId(company.id)}
                    >
                      {company.name}
                    </button>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                      {company.id.slice(0, 8)}
                    </div>
                  </TableCell>
                  <TableCell className={statusClass(company.status)}>
                    {companyStatusLabel(company.status)}
                  </TableCell>
                  <TableCell>{company.userCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    组 {company.accountGroupCount} / 账户 {company.adAccountCount}
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditCompany(company)}>
                      <Pencil className="mr-1 h-3 w-3" />
                      改名
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!isPlatformAdmin || me.data?.companyId === company.id || switchCompany.isPending}
                      onClick={() => switchCompany.mutate(company.id)}
                    >
                      切换
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <section className="space-y-4">
          <section className="rounded-md border bg-background p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">{selectedCompany?.name ?? '公司详情'}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedCompany ? `公司 ID ${selectedCompany.id}` : '请选择公司'}
                </p>
              </div>
              {selectedCompany && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => goIam(selectedCompany.id)} disabled={switchCompany.isPending}>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    IAM 权限管理
                  </Button>
                </div>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-md border bg-background">
            <div className="border-b p-3">
              <h2 className="font-medium">公司人员</h2>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>作用域</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQ.isLoading && <EmptyRow colSpan={4} text="加载中..." />}
                {!usersQ.isLoading && (usersQ.data ?? []).length === 0 && (
                  <EmptyRow colSpan={4} text="暂无人员" />
                )}
                {(usersQ.data ?? []).map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.email}</TableCell>
                    <TableCell>{user.roles.join(', ') || '-'}</TableCell>
                    <TableCell className={statusClass(user.status)}>
                      {userStatusLabel(user.status)}
                    </TableCell>
                    <TableCell>{user.grantsCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </section>
      </section>

      <CompanyDialog
        open={createCompanyOpen}
        title="新增公司"
        submitText="创建"
        submitting={createCompany.isPending}
        onCancel={() => setCreateCompanyOpen(false)}
        onSubmit={(name) => createCompany.mutate(name)}
      />
      <CompanyDialog
        open={!!editCompany}
        title="修改公司名称"
        submitText="保存"
        initialValue={editCompany?.name ?? ''}
        submitting={updateCompany.isPending}
        onCancel={() => setEditCompany(null)}
        onSubmit={(name) => editCompany && updateCompany.mutate({ id: editCompany.id, name })}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
}) {
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function CompanyDialog({
  open,
  title,
  submitText,
  initialValue = '',
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitText: string;
  initialValue?: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialValue);
  useEffect(() => {
    if (open) setName(initialValue);
  }, [initialValue, open]);
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()} title={title}>
      <label className="space-y-1.5 text-sm">
        <span className="text-xs text-muted-foreground">公司名称</span>
        <Input value={name} onChange={(event) => setName(event.currentTarget.value)} autoFocus />
      </label>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button disabled={submitting || !name.trim()} onClick={() => onSubmit(name.trim())}>
          {submitting ? '提交中...' : submitText}
        </Button>
      </DialogFooter>
    </Dialog>
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
  if (status === 'active') return 'text-emerald-600';
  if (status === 'disabled') return 'text-rose-600';
  return 'text-muted-foreground';
}
