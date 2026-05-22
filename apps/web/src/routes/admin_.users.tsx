import { createFileRoute, redirect, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Building2, Plus, ShieldCheck, Users } from 'lucide-react';
import { api, getToken, setToken, type Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
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
import { userStatusLabel } from '@/lib/labels';

export const Route = createFileRoute('/admin_/users')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: UsersPage,
});

type CompanyRow = Awaited<ReturnType<typeof api.listCompanies>>[number];
type UserRow = Awaited<ReturnType<typeof api.listCompanyUsers>>[number];

type RoleCode = 'CompanyAdmin' | 'Operator' | 'Viewer';

const ROLE_OPTIONS: Array<{ code: RoleCode; label: string }> = [
  { code: 'CompanyAdmin', label: '公司管理员' },
  { code: 'Operator', label: '操作员' },
  { code: 'Viewer', label: '只读' },
];

const ROLE_FILTER_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'PlatformAdmin', label: '平台超管' },
  ...ROLE_OPTIONS.map((role) => ({ value: role.code, label: role.label })),
];

function UsersPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const companiesQ = useQuery({ queryKey: ['admin', 'companies'], queryFn: api.listCompanies });
  const companies = companiesQ.data ?? [];
  const isPlatformAdmin = me.data?.roles.includes('PlatformAdmin') ?? false;

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

  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    if (!me.data || companies.length === 0) return;
    if (!selectedCompanyId || !companies.some((company) => company.id === selectedCompanyId)) {
      const currentCompany = companies.find((company) => company.id === me.data.companyId);
      setSelectedCompanyId((currentCompany ?? companies[0]!).id);
    }
  }, [companies, me.data, selectedCompanyId]);

  const create = useMutation({
    mutationFn: (args: { email: string; password: string; roleCode: RoleCode }) => {
      if (!selectedCompany) throw new Error('请选择公司');
      return api.createCompanyUser(selectedCompany.id, args);
    },
    onSuccess: () => {
      setCreating(false);
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
      qc.invalidateQueries({ queryKey: ['admin', 'company-users', selectedCompany?.id ?? 'none'] });
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  const update = useMutation({
    mutationFn: ({
      companyId,
      id,
      patch,
    }: {
      companyId: string;
      id: string;
      patch: { roleCode?: RoleCode; status?: 'active' | 'disabled' };
    }) => api.updateCompanyUser(companyId, id, patch),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
      qc.invalidateQueries({ queryKey: ['admin', 'company-users', variables.companyId] });
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const switchCompany = useMutation({
    mutationFn: (companyId: string) => api.switchCompany(companyId),
  });

  const users = usersQ.data ?? [];
  const filtered = useMemo(
    () =>
      users.filter(
        (user) =>
          [user.email, selectedCompany?.name ?? '', user.roles.join(' ')].some((value) =>
            matchText(value, search),
          ) &&
          (!roleFilter || user.roles.includes(roleFilter)) &&
          (!statusFilter || user.status === statusFilter),
      ),
    [roleFilter, search, selectedCompany?.name, statusFilter, users],
  );
  const pager = usePagination(filtered);

  const error =
    (me.error as Error | null)?.message ??
    (companiesQ.error as Error | null)?.message ??
    (usersQ.error as Error | null)?.message ??
    (create.error as Error | null)?.message ??
    (update.error as Error | null)?.message ??
    (switchCompany.error as Error | null)?.message;

  async function goIam(userId?: string) {
    if (!selectedCompany) return;
    if (isPlatformAdmin && me.data?.companyId !== selectedCompany.id) {
      const result = await switchCompany.mutateAsync(selectedCompany.id);
      setToken(result.token);
      qc.clear();
    }
    navigate({ to: '/admin/iam', search: userId ? { userId } : {} });
  }

  function updateUser(
    user: UserRow,
    patch: { roleCode?: RoleCode; status?: 'active' | 'disabled' },
  ) {
    if (!selectedCompany) return;
    update.mutate({ companyId: selectedCompany.id, id: user.id, patch });
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
            <Users className="h-4 w-4" />
            <span>用户目录</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">用户与角色</h1>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goIam()}
            disabled={!selectedCompany || switchCompany.isPending}
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            IAM权限管理
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} disabled={!selectedCompany}>
            <Plus className="mr-2 h-4 w-4" />
            新建用户
          </Button>
        </div>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <label className="text-xs text-muted-foreground">公司</label>
        </div>
        <select
          value={selectedCompany?.id ?? ''}
          disabled={!isPlatformAdmin || companiesQ.isLoading || companies.length <= 1}
          onChange={(event) => setSelectedCompanyId(event.currentTarget.value)}
          className="h-9 min-w-72 rounded-md border border-input bg-background px-3 text-sm disabled:bg-muted"
        >
          {companies.length === 0 && <option value="">加载中</option>}
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        {!isPlatformAdmin && <span className="text-xs text-muted-foreground">仅超管可切换公司</span>}
      </section>

      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索邮箱、公司或角色"
        filters={[
          {
            key: 'role',
            label: '角色',
            value: roleFilter,
            onChange: setRoleFilter,
            options: ROLE_FILTER_OPTIONS,
          },
          {
            key: 'status',
            label: '状态',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: '', label: '全部' },
              { value: 'active', label: userStatusLabel('active') },
              { value: 'disabled', label: userStatusLabel('disabled') },
            ],
          },
        ]}
        total={users.length}
        filtered={filtered.length}
        onReset={() => {
          setSearch('');
          setRoleFilter('');
          setStatusFilter('');
        }}
      />

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>公司</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(companiesQ.isLoading || usersQ.isLoading) && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  加载中...
                </TableCell>
              </TableRow>
            )}
            {!companiesQ.isLoading && !usersQ.isLoading && users.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  暂无用户
                </TableCell>
              </TableRow>
            )}
            {!companiesQ.isLoading &&
              !usersQ.isLoading &&
              users.length > 0 &&
              filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    无匹配项
                  </TableCell>
                </TableRow>
              )}
            {pager.pageItems.map((user) => (
              <UserTableRow
                key={user.id}
                user={user}
                company={selectedCompany}
                updating={update.isPending}
                switching={switchCompany.isPending}
                onUpdate={(patch) => updateUser(user, patch)}
                onIam={() => goIam(user.id)}
              />
            ))}
          </TableBody>
        </Table>
        <Pagination
          page={pager.page}
          pageCount={pager.pageCount}
          total={filtered.length}
          onPageChange={pager.setPage}
        />
      </div>

      <CreateUserDialog
        open={creating}
        companyName={selectedCompany?.name ?? ''}
        onCancel={() => setCreating(false)}
        onSubmit={(args) => create.mutate(args)}
        submitting={create.isPending}
      />
    </div>
  );
}

function UserTableRow({
  user,
  company,
  updating,
  switching,
  onUpdate,
  onIam,
}: {
  user: UserRow;
  company: CompanyRow | null;
  updating: boolean;
  switching: boolean;
  onUpdate: (patch: { roleCode?: RoleCode; status?: 'active' | 'disabled' }) => void;
  onIam: () => void;
}) {
  const companyRole = ROLE_OPTIONS.find((role) => user.roles.includes(role.code))?.code ?? '';
  const isPlatformAdmin = user.roles.includes('PlatformAdmin');

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{company?.name ?? '-'}</div>
        {company && <div className="mt-1 font-mono text-xs text-muted-foreground">{company.id.slice(0, 8)}</div>}
      </TableCell>
      <TableCell>
        <div className="font-medium">{user.email}</div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">{user.id.slice(0, 8)}</div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={companyRole}
            disabled={updating}
            onChange={(event) => onUpdate({ roleCode: event.target.value as RoleCode })}
          >
            {!companyRole && <option value="">未分配</option>}
            {ROLE_OPTIONS.map((role) => (
              <option key={role.code} value={role.code}>
                {role.label}
              </option>
            ))}
          </select>
          {isPlatformAdmin && (
            <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
              平台超管
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={user.status}
          disabled={updating}
          onChange={(event) => onUpdate({ status: event.target.value as 'active' | 'disabled' })}
        >
          <option value="active">{userStatusLabel('active')}</option>
          <option value="disabled">{userStatusLabel('disabled')}</option>
        </select>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {new Date(user.createdAt).toLocaleString()}
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="outline" disabled={switching} onClick={onIam}>
          IAM权限管理
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CreateUserDialog({
  open,
  companyName,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  companyName: string;
  onCancel: () => void;
  onSubmit: (args: { email: string; password: string; roleCode: RoleCode }) => void;
  submitting: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState<RoleCode>('Operator');

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setPassword('');
    setRoleCode('Operator');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()} title="新建用户">
      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground">公司</label>
          <Input value={companyName} disabled />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">邮箱</label>
          <Input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">密码，至少 6 位</label>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">角色</label>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={roleCode}
            onChange={(event) => setRoleCode(event.target.value as RoleCode)}
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role.code} value={role.code}>
                {role.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button
          disabled={submitting || !email || password.length < 6 || !roleCode}
          onClick={() => onSubmit({ email, password, roleCode })}
        >
          {submitting ? '创建中...' : '创建'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
