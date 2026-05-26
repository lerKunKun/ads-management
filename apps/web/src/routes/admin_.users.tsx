import { createFileRoute, redirect, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Building2, KeyRound, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
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
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [notice, setNotice] = useState('');

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

  const deleteUser = useMutation({
    mutationFn: ({ companyId, id }: { companyId: string; id: string }) =>
      api.deleteCompanyUser(companyId, id),
    onSuccess: (_data, variables) => {
      setDeleteTarget(null);
      setNotice('用户已删除');
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
      qc.invalidateQueries({ queryKey: ['admin', 'company-users', variables.companyId] });
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  const changePassword = useMutation({
    mutationFn: (args: { currentPassword: string; newPassword: string }) =>
      api.changeOwnPassword(args),
    onSuccess: () => {
      setPasswordDialogOpen(false);
      setNotice('超管密码已更新');
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
    (deleteUser.error as Error | null)?.message ??
    (changePassword.error as Error | null)?.message ??
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
    setNotice('');
    update.mutate({ companyId: selectedCompany.id, id: user.id, patch });
  }

  function confirmDeleteUser() {
    if (!selectedCompany || !deleteTarget) return;
    setNotice('');
    deleteUser.mutate({ companyId: selectedCompany.id, id: deleteTarget.id });
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
          {isPlatformAdmin && (
            <Button variant="outline" size="sm" onClick={() => setPasswordDialogOpen(true)}>
              <KeyRound className="mr-2 h-4 w-4" />
              修改超管密码
            </Button>
          )}
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
      {notice && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
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
                currentUserId={me.data?.id ?? ''}
                canManageUsers={isPlatformAdmin}
                updating={update.isPending || deleteUser.isPending}
                switching={switchCompany.isPending}
                onUpdate={(patch) => updateUser(user, patch)}
                onIam={() => goIam(user.id)}
                onDelete={() => setDeleteTarget(user)}
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
      <ChangePasswordDialog
        open={passwordDialogOpen}
        onCancel={() => setPasswordDialogOpen(false)}
        onSubmit={(args) => {
          setNotice('');
          changePassword.mutate(args);
        }}
        submitting={changePassword.isPending}
      />
      <DeleteUserDialog
        user={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteUser}
        submitting={deleteUser.isPending}
      />
    </div>
  );
}

function UserTableRow({
  user,
  company,
  currentUserId,
  canManageUsers,
  updating,
  switching,
  onUpdate,
  onIam,
  onDelete,
}: {
  user: UserRow;
  company: CompanyRow | null;
  currentUserId: string;
  canManageUsers: boolean;
  updating: boolean;
  switching: boolean;
  onUpdate: (patch: { roleCode?: RoleCode; status?: 'active' | 'disabled' }) => void;
  onIam: () => void;
  onDelete: () => void;
}) {
  const companyRole = ROLE_OPTIONS.find((role) => user.roles.includes(role.code))?.code ?? '';
  const isPlatformAdmin = user.roles.includes('PlatformAdmin');
  const isSelf = user.id === currentUserId;
  const canEditThisUser = canManageUsers && !isPlatformAdmin;
  const canDeleteThisUser = canEditThisUser && !isSelf;

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
            disabled={updating || !canEditThisUser}
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
          disabled={updating || !canEditThisUser}
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
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={switching} onClick={onIam}>
            IAM权限管理
          </Button>
          {canManageUsers && (
            <Button
              size="sm"
              variant="outline"
              disabled={updating || !canDeleteThisUser}
              onClick={onDelete}
              title={isPlatformAdmin ? '平台超管不能删除' : isSelf ? '不能删除自己' : '删除用户'}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              删除
            </Button>
          )}
        </div>
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

function ChangePasswordDialog({
  open,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (args: { currentPassword: string; newPassword: string }) => void;
  submitting: boolean;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const mismatch = !!confirmPassword && newPassword !== confirmPassword;

  useEffect(() => {
    if (!open) return;
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()} title="修改超管密码">
      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground">当前密码</label>
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">新密码，至少 8 位</label>
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">确认新密码</label>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {mismatch && <p className="mt-1 text-xs text-destructive">两次输入的新密码不一致</p>}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button
          disabled={
            submitting ||
            !currentPassword ||
            newPassword.length < 8 ||
            newPassword !== confirmPassword
          }
          onClick={() => onSubmit({ currentPassword, newPassword })}
        >
          {submitting ? '保存中...' : '保存'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DeleteUserDialog({
  user,
  onCancel,
  onConfirm,
  submitting,
}: {
  user: UserRow | null;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  return (
    <Dialog open={!!user} onOpenChange={(nextOpen) => !nextOpen && onCancel()} title="删除用户">
      <div className="space-y-2 text-sm">
        <p>确认删除这个用户？</p>
        <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs">{user?.email ?? '-'}</p>
        <p className="text-muted-foreground">
          删除后会移除该用户的角色和广告账户授权，历史审计记录会保留。
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button variant="destructive" disabled={submitting || !user} onClick={onConfirm}>
          {submitting ? '删除中...' : '确认删除'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
