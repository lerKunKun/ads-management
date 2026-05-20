import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
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

export const Route = createFileRoute('/admin_/users')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: UsersPage,
});

interface UserRow {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  createdAt: string;
  roles: string[];
  grantsCount: number;
}

function UsersPage() {
  const qc = useQueryClient();
  const usersQ = useQuery({ queryKey: ['admin', 'users'], queryFn: api.listUsers });
  const rolesQ = useQuery({ queryKey: ['admin', 'roles'], queryFn: api.listRoles });

  const [creating, setCreating] = useState(false);
  const [editingScope, setEditingScope] = useState<UserRow | null>(null);

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  const users = usersQ.data ?? [];
  const roles = rolesQ.data ?? [];

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = useMemo(
    () =>
      users.filter(
        (u) =>
          matchText(u.email, search) &&
          (!roleFilter || u.roles.includes(roleFilter)) &&
          (!statusFilter || u.status === statusFilter),
      ),
    [users, search, roleFilter, statusFilter],
  );

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link to="/admin" className="hover:text-foreground">
          ← 返回管理
        </Link>
      </div>
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">用户与作用域</h1>
        <Button size="sm" onClick={() => setCreating(true)}>
          新建用户
        </Button>
      </header>

      {(usersQ.error || rolesQ.error || create.error || update.error) && (
        <p className="text-sm text-destructive">
          {(usersQ.error as Error)?.message ||
            (rolesQ.error as Error)?.message ||
            (create.error as Error)?.message ||
            (update.error as Error)?.message}
        </p>
      )}

      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索邮箱…"
        filters={[
          {
            key: 'role',
            label: '角色',
            value: roleFilter,
            onChange: setRoleFilter,
            options: [
              { value: '', label: '全部' },
              ...roles.map((r) => ({ value: r.code, label: r.code })),
            ],
          },
          {
            key: 'status',
            label: '状态',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: '', label: '全部' },
              { value: 'active', label: 'active' },
              { value: 'disabled', label: 'disabled' },
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

      <div className="border rounded-md">
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
                  加载中…
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
            {filtered.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.email}</TableCell>
                <TableCell>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    value={u.roles[0] ?? ''}
                    disabled={update.isPending}
                    onChange={(e) =>
                      update.mutate({
                        id: u.id,
                        patch: { roleCode: e.target.value },
                      })
                    }
                  >
                    {!u.roles.length && <option value="">—</option>}
                    {roles.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.name} ({r.code})
                      </option>
                    ))}
                  </select>
                </TableCell>
                <TableCell>
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    value={u.status}
                    disabled={update.isPending}
                    onChange={(e) =>
                      update.mutate({
                        id: u.id,
                        patch: {
                          status: e.target.value as 'active' | 'disabled',
                        },
                      })
                    }
                  >
                    <option value="active">active</option>
                    <option value="disabled">disabled</option>
                  </select>
                </TableCell>
                <TableCell className="text-sm">{u.grantsCount}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(u.createdAt).toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingScope(u)}
                  >
                    编辑作用域
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <CreateUserDialog
        open={creating}
        roles={roles}
        onCancel={() => setCreating(false)}
        onSubmit={(args) => create.mutate(args)}
        submitting={create.isPending}
      />

      <ScopeDialog
        user={editingScope}
        onClose={() => {
          setEditingScope(null);
          qc.invalidateQueries({ queryKey: ['admin', 'users'] });
        }}
      />
    </div>
  );
}

/* ===================== Create dialog ===================== */
function CreateUserDialog({
  open,
  roles,
  onCancel,
  onSubmit,
  submitting,
}: {
  open: boolean;
  roles: Array<{ code: string; name: string }>;
  onCancel: () => void;
  onSubmit: (args: { email: string; password: string; roleCode: string }) => void;
  submitting: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState('Operator');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()} title="新建用户">
      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground">邮箱</label>
          <Input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">密码 (≥6 位)</label>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">角色</label>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={roleCode}
            onChange={(e) => setRoleCode(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name} ({r.code})
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
          disabled={submitting || !email || password.length < 6}
          onClick={() => onSubmit({ email, password, roleCode })}
        >
          {submitting ? '创建中…' : '创建'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ===================== Scope dialog ===================== */
function ScopeDialog({
  user,
  onClose,
}: {
  user: UserRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const grantsQ = useQuery({
    queryKey: ['admin', 'grants', user?.id],
    queryFn: () => (user ? api.listGrants(user.id) : Promise.resolve([])),
    enabled: !!user,
  });
  const resQ = useQuery({
    queryKey: ['admin', 'grant-resources'],
    queryFn: api.listGrantResources,
    enabled: !!user,
  });

  const add = useMutation({
    mutationFn: ({
      type,
      id,
    }: {
      type: 'fb_account' | 'ad_account';
      id: string;
    }) => api.addGrant(user!.id, type, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'grants', user?.id] }),
  });
  const remove = useMutation({
    mutationFn: (grantId: string) => api.removeGrant(user!.id, grantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'grants', user?.id] }),
  });

  if (!user) return null;
  const grants = grantsQ.data ?? [];
  const fb = resQ.data?.fbAccounts ?? [];
  const ad = resQ.data?.adAccounts ?? [];

  const grantedFb = new Set(
    grants.filter((g) => g.resourceType === 'fb_account').map((g) => g.resourceId),
  );
  const grantedAd = new Set(
    grants.filter((g) => g.resourceType === 'ad_account').map((g) => g.resourceId),
  );

  function toggleFb(id: string) {
    const existing = grants.find(
      (g) => g.resourceType === 'fb_account' && g.resourceId === id,
    );
    if (existing) remove.mutate(existing.id);
    else add.mutate({ type: 'fb_account', id });
  }
  function toggleAd(id: string) {
    const existing = grants.find(
      (g) => g.resourceType === 'ad_account' && g.resourceId === id,
    );
    if (existing) remove.mutate(existing.id);
    else add.mutate({ type: 'ad_account', id });
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`编辑作用域 · ${user.email}`}
    >
      <p className="text-sm text-muted-foreground mb-3">
        勾选用户可访问的 FB 个号 或 单个广告账户。CompanyAdmin / PlatformAdmin 自动绕过作用域(不需要授权)。
      </p>

      {(grantsQ.error || resQ.error || add.error || remove.error) && (
        <p className="text-sm text-destructive mb-2">
          {(grantsQ.error as Error)?.message ||
            (resQ.error as Error)?.message ||
            (add.error as Error)?.message ||
            (remove.error as Error)?.message}
        </p>
      )}

      <div className="space-y-4 max-h-96 overflow-auto">
        <section>
          <h3 className="text-sm font-medium mb-2">
            FB 个号 ({grantedFb.size}/{fb.length})
          </h3>
          {fb.length === 0 ? (
            <p className="text-xs text-muted-foreground">本公司无 FB 个号</p>
          ) : (
            <ul className="space-y-1">
              {fb.map((f) => (
                <li key={f.id} className="text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={grantedFb.has(f.id)}
                      onChange={() => toggleFb(f.id)}
                      disabled={add.isPending || remove.isPending}
                    />
                    <span>{f.name}</span>
                    <span className="text-xs text-muted-foreground">({f.status})</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="text-sm font-medium mb-2">
            广告账户 ({grantedAd.size}/{ad.length})
          </h3>
          {ad.length === 0 ? (
            <p className="text-xs text-muted-foreground">本公司无广告账户</p>
          ) : (
            <ul className="space-y-1">
              {ad.map((a) => (
                <li key={a.id} className="text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={grantedAd.has(a.id)}
                      onChange={() => toggleAd(a.id)}
                      disabled={add.isPending || remove.isPending}
                    />
                    <span>{a.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {a.metaActId}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <DialogFooter>
        <Button onClick={onClose}>关闭</Button>
      </DialogFooter>
    </Dialog>
  );
}
