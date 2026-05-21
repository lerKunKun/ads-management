import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Plus, ShieldCheck, Users } from 'lucide-react';
import { api, getToken } from '@/lib/api';
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

type UserRow = Awaited<ReturnType<typeof api.listUsers>>[number];
type RoleOption = Awaited<ReturnType<typeof api.listRoles>>[number];

function UsersPage() {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: ['admin', 'users'], queryFn: api.listUsers });
  const rolesQ = useQuery({ queryKey: ['admin', 'roles'], queryFn: api.listRoles });

  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const create = useMutation({
    mutationFn: (args: { email: string; password: string; roleCode: string }) =>
      api.createUser(args.email, args.password, args.roleCode),
    onSuccess: () => {
      setCreating(false);
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });

  const update = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { roleCode?: string; status?: 'active' | 'disabled' };
    }) => api.updateUser(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const users = usersQ.data ?? [];
  const roles = rolesQ.data ?? [];
  const filtered = useMemo(
    () =>
      users.filter(
        (user) =>
          matchText(user.email, search) &&
          (!roleFilter || user.roles.includes(roleFilter)) &&
          (!statusFilter || user.status === statusFilter),
      ),
    [roleFilter, search, statusFilter, users],
  );
  const pager = usePagination(filtered);
  const error =
    (usersQ.error as Error | null)?.message ??
    (rolesQ.error as Error | null)?.message ??
    (create.error as Error | null)?.message ??
    (update.error as Error | null)?.message;

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
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/iam" search={{}}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              IAM 权限
            </Link>
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
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

      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索邮箱"
        filters={[
          {
            key: 'role',
            label: '角色',
            value: roleFilter,
            onChange: setRoleFilter,
            options: [
              { value: '', label: '全部' },
              ...roles.map((role) => ({ value: role.code, label: role.code })),
            ],
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
              <TableHead>邮箱</TableHead>
              <TableHead>角色</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>作用域数</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersQ.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  加载中...
                </TableCell>
              </TableRow>
            )}
            {!usersQ.isLoading && users.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  暂无用户
                </TableCell>
              </TableRow>
            )}
            {!usersQ.isLoading && users.length > 0 && filtered.length === 0 && (
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
                roles={roles}
                updating={update.isPending}
                onUpdate={(patch) => update.mutate({ id: user.id, patch })}
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
        roles={roles}
        onCancel={() => setCreating(false)}
        onSubmit={(args) => create.mutate(args)}
        submitting={create.isPending}
      />
    </div>
  );
}

function UserTableRow({
  user,
  roles,
  updating,
  onUpdate,
}: {
  user: UserRow;
  roles: RoleOption[];
  updating: boolean;
  onUpdate: (patch: { roleCode?: string; status?: 'active' | 'disabled' }) => void;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{user.email}</TableCell>
      <TableCell>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={user.roles[0] ?? ''}
          disabled={updating}
          onChange={(event) => onUpdate({ roleCode: event.target.value })}
        >
          {!user.roles.length && <option value="">未分配</option>}
          {roles.map((role) => (
            <option key={role.code} value={role.code}>
              {role.name} ({role.code})
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell>
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={user.status}
          disabled={updating}
          onChange={(event) =>
            onUpdate({ status: event.target.value as 'active' | 'disabled' })
          }
        >
          <option value="active">{userStatusLabel('active')}</option>
          <option value="disabled">{userStatusLabel('disabled')}</option>
        </select>
      </TableCell>
      <TableCell className="text-sm">{user.grantsCount}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {new Date(user.createdAt).toLocaleString()}
      </TableCell>
      <TableCell className="text-right">
        <Button asChild size="sm" variant="outline">
          <Link to="/admin/iam" search={{ userId: user.id }}>
            分配作用域
          </Link>
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CreateUserDialog({
  open,
  roles,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  roles: RoleOption[];
  onCancel: () => void;
  onSubmit: (args: { email: string; password: string; roleCode: string }) => void;
  submitting: boolean;
}) {
  const defaultRole = roles.find((role) => role.code === 'Operator')?.code ?? roles[0]?.code ?? '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState(defaultRole);

  useEffect(() => {
    if (!roleCode && defaultRole) setRoleCode(defaultRole);
  }, [defaultRole, roleCode]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()} title="新建用户">
      <div className="space-y-3">
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
            onChange={(event) => setRoleCode(event.target.value)}
          >
            {roles.map((role) => (
              <option key={role.code} value={role.code}>
                {role.name} ({role.code})
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
