import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  CircleSlash,
  KeyRound,
  Search,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { api, getToken, type Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { accountGroupStatusLabel, adAccountStatusLabel, userStatusLabel } from '@/lib/labels';

type UserRow = Awaited<ReturnType<typeof api.listUsers>>[number];
type Grant = Awaited<ReturnType<typeof api.listGrants>>[number];
type GrantResources = Awaited<ReturnType<typeof api.listGrantResources>>;
type FbResource = GrantResources['fbAccounts'][number];
type AdResource = GrantResources['adAccounts'][number];
type ResourceType = 'fb_account' | 'ad_account';
type IamSearch = { userId?: string };

export const Route = createFileRoute('/admin_/iam')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  validateSearch: (search: Record<string, unknown>): IamSearch =>
    typeof search.userId === 'string' ? { userId: search.userId } : {},
  component: IamWorkspacePage,
});

type GrantChange =
  | { action: 'add'; resourceType: ResourceType; resourceId: string }
  | { action: 'remove'; grantId: string };

const BYPASS_ROLES = new Set(['CompanyAdmin', 'PlatformAdmin']);

function IamWorkspacePage() {
  const routeSearch = Route.useSearch();
  const qc = useQueryClient();
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const usersQ = useQuery({ queryKey: ['admin', 'users'], queryFn: api.listUsers });
  const resourcesQ = useQuery({
    queryKey: ['admin', 'grant-resources'],
    queryFn: api.listGrantResources,
  });

  const [selectedUserId, setSelectedUserId] = useState(routeSearch.userId ?? '');
  const [userSearch, setUserSearch] = useState('');
  const [fbSearch, setFbSearch] = useState('');
  const [adSearch, setAdSearch] = useState('');

  const users = usersQ.data ?? [];
  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? users[0] ?? null,
    [selectedUserId, users],
  );

  useEffect(() => {
    if (users.length === 0) {
      if (selectedUserId) setSelectedUserId('');
      return;
    }
    if (!users.some((user) => user.id === selectedUserId)) {
      setSelectedUserId(users[0]?.id ?? '');
    }
  }, [selectedUserId, users]);

  useEffect(() => {
    if (!routeSearch.userId) return;
    if (users.length > 0 && !users.some((user) => user.id === routeSearch.userId)) return;
    if (routeSearch.userId !== selectedUserId) setSelectedUserId(routeSearch.userId);
  }, [routeSearch.userId, selectedUserId, users]);

  const grantsQ = useQuery({
    queryKey: ['admin', 'grants', selectedUser?.id ?? 'none'],
    queryFn: () => api.listGrants(selectedUser!.id),
    enabled: !!selectedUser,
  });

  const grantMutation = useMutation({
    mutationFn: async ({ userId, ops }: { userId: string; ops: GrantChange[] }) => {
      for (const op of ops) {
        if (op.action === 'add') {
          await api.addGrant(userId, op.resourceType, op.resourceId);
        } else {
          await api.removeGrant(userId, op.grantId);
        }
      }
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['admin', 'grants', variables.userId] });
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });

  const grants = grantsQ.data ?? [];
  const grantByKey = useMemo(() => {
    const map = new Map<string, Grant>();
    for (const grant of grants) {
      map.set(grantKey(grant.resourceType, grant.resourceId), grant);
    }
    return map;
  }, [grants]);

  const grantedFbIds = useMemo(
    () =>
      new Set(
        grants
          .filter((grant) => grant.resourceType === 'fb_account')
          .map((grant) => grant.resourceId),
      ),
    [grants],
  );
  const grantedAdIds = useMemo(
    () =>
      new Set(
        grants
          .filter((grant) => grant.resourceType === 'ad_account')
          .map((grant) => grant.resourceId),
      ),
    [grants],
  );

  const fbAccounts = resourcesQ.data?.fbAccounts ?? [];
  const adAccounts = resourcesQ.data?.adAccounts ?? [];
  const fbNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const account of fbAccounts) map.set(account.id, account.name);
    return map;
  }, [fbAccounts]);

  const filteredUsers = useMemo(
    () =>
      users.filter((user) =>
        [user.email, user.status, user.roles.join(' ')].some((value) =>
          value.toLowerCase().includes(userSearch.trim().toLowerCase()),
        ),
      ),
    [userSearch, users],
  );

  const filteredFbAccounts = useMemo(
    () =>
      fbAccounts.filter((account) =>
        [account.name, account.id, account.status].some((value) =>
          value.toLowerCase().includes(fbSearch.trim().toLowerCase()),
        ),
      ),
    [fbAccounts, fbSearch],
  );

  const scopedAdAccounts = useMemo(
    () =>
      grantedFbIds.size === 0
        ? adAccounts
        : adAccounts.filter((account) => grantedFbIds.has(account.fbAccountId)),
    [adAccounts, grantedFbIds],
  );

  const filteredAdAccounts = useMemo(
    () =>
      scopedAdAccounts.filter((account) =>
        [
          account.name,
          account.metaActId,
          account.status,
          account.currency ?? '',
          fbNameById.get(account.fbAccountId) ?? '',
        ].some((value) => value.toLowerCase().includes(adSearch.trim().toLowerCase())),
      ),
    [adSearch, fbNameById, scopedAdAccounts],
  );

  const bypassScope = selectedUser?.roles.some((role) => BYPASS_ROLES.has(role)) ?? false;
  const busy = grantMutation.isPending;

  function toggleResource(resourceType: ResourceType, resourceId: string) {
    if (!selectedUser || bypassScope || busy) return;
    const current = grantByKey.get(grantKey(resourceType, resourceId));
    const ops: GrantChange[] = current
      ? [{ action: 'remove', grantId: current.id }]
      : [{ action: 'add', resourceType, resourceId }];
    grantMutation.mutate({ userId: selectedUser.id, ops });
  }

  function bulkChange(
    resourceType: ResourceType,
    resourceIds: string[],
    mode: 'select' | 'clear' | 'invert',
  ) {
    if (!selectedUser || bypassScope || busy) return;
    const ops: GrantChange[] = [];
    for (const resourceId of resourceIds) {
      const current = grantByKey.get(grantKey(resourceType, resourceId));
      if (mode === 'select' && !current) {
        ops.push({ action: 'add', resourceType, resourceId });
      }
      if (mode === 'clear' && current) {
        ops.push({ action: 'remove', grantId: current.id });
      }
      if (mode === 'invert') {
        ops.push(
          current
            ? { action: 'remove', grantId: current.id }
            : { action: 'add', resourceType, resourceId },
        );
      }
    }
    if (ops.length > 0) grantMutation.mutate({ userId: selectedUser.id, ops });
  }

  const error =
    (me.error as Error | null)?.message ??
    (usersQ.error as Error | null)?.message ??
    (resourcesQ.error as Error | null)?.message ??
    (grantsQ.error as Error | null)?.message ??
    (grantMutation.error as Error | null)?.message;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm text-muted-foreground">
            <Link to="/admin" className="hover:text-foreground">
              返回管理中心
            </Link>
          </div>
          <h1 className="mt-1 text-xl font-semibold">IAM 权限工作台</h1>
        </div>
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <select
            value={me.data?.companyId ?? ''}
            disabled
            className="h-9 min-w-72 rounded-md border border-input bg-muted px-3 text-sm"
          >
            <option value={me.data?.companyId ?? ''}>
              当前公司 {me.data?.companyId ?? '加载中'}
            </option>
          </select>
        </div>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:h-[calc(100vh-10.5rem)] lg:grid-cols-[1fr_1fr_1.2fr]">
        <Pane
          title="用户/员工"
          subtitle={`${filteredUsers.length} / ${users.length} 人`}
          actions={
            <SearchInput
              value={userSearch}
              onChange={setUserSearch}
              placeholder="搜索邮箱或角色"
            />
          }
        >
          {usersQ.isLoading && <EmptyState text="用户加载中" />}
          {!usersQ.isLoading && filteredUsers.length === 0 && <EmptyState text="无匹配用户" />}
          <div className="space-y-2 p-3">
            {filteredUsers.map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={cn(
                  'w-full rounded-md border p-3 text-left transition-colors',
                  selectedUser?.id === user.id
                    ? 'border-primary bg-primary/5'
                    : 'bg-background hover:bg-muted/50',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                    {user.email.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{user.email}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {user.roles.length > 0 ? (
                        user.roles.map((role) => <RoleBadge key={role} role={role} />)
                      ) : (
                        <span className="text-xs text-muted-foreground">未分配角色</span>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <StatusBadge status={user.status} />
                      <span>作用域 {user.grantsCount}</span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Pane>

        <Pane
          title="广告账户组"
          subtitle={`${grantedFbIds.size} / ${fbAccounts.length} 已授权`}
          actions={
            <SearchInput
              value={fbSearch}
              onChange={setFbSearch}
              placeholder="过滤名称或 ID"
            />
          }
        >
          <div className="border-b px-3 py-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={bypassScope || busy || filteredFbAccounts.length === 0}
                onClick={() =>
                  bulkChange(
                    'fb_account',
                    filteredFbAccounts.map((account) => account.id),
                    'select',
                  )
                }
              >
                全选
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bypassScope || busy || filteredFbAccounts.length === 0}
                onClick={() =>
                  bulkChange(
                    'fb_account',
                    filteredFbAccounts.map((account) => account.id),
                    'invert',
                  )
                }
              >
                反选
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bypassScope || busy || grantedFbIds.size === 0}
                onClick={() =>
                  bulkChange(
                    'fb_account',
                    filteredFbAccounts.map((account) => account.id),
                    'clear',
                  )
                }
              >
                清空
              </Button>
            </div>
          </div>
          {bypassScope && <BypassNotice />}
          {resourcesQ.isLoading && <EmptyState text="广告账户组加载中" />}
          {!resourcesQ.isLoading && filteredFbAccounts.length === 0 && (
            <EmptyState text="无匹配广告账户组" />
          )}
          <div className="space-y-2 p-3">
            {filteredFbAccounts.map((account) => (
              <FbAccountRow
                key={account.id}
                account={account}
                checked={grantedFbIds.has(account.id)}
                disabled={bypassScope || busy}
                onToggle={() => toggleResource('fb_account', account.id)}
              />
            ))}
          </div>
        </Pane>

        <Pane
          title="广告账户作用域"
          subtitle={`${grantedAdIds.size} / ${adAccounts.length} 已授权`}
          actions={
            <SearchInput
              value={adSearch}
              onChange={setAdSearch}
              placeholder="过滤 act_id / 名称"
            />
          }
        >
          <div className="sticky top-0 z-10 border-b bg-background px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                当前显示 {filteredAdAccounts.length} 个
                {grantedFbIds.size > 0 ? `，受 ${grantedFbIds.size} 个广告账户组过滤` : ''}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bypassScope || busy || filteredAdAccounts.length === 0}
                  onClick={() =>
                    bulkChange(
                      'ad_account',
                      filteredAdAccounts.map((account) => account.id),
                      'select',
                    )
                  }
                >
                  全选
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bypassScope || busy || filteredAdAccounts.length === 0}
                  onClick={() =>
                    bulkChange(
                      'ad_account',
                      filteredAdAccounts.map((account) => account.id),
                      'invert',
                    )
                  }
                >
                  反选
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bypassScope || busy || grantedAdIds.size === 0}
                  onClick={() =>
                    bulkChange(
                      'ad_account',
                      filteredAdAccounts.map((account) => account.id),
                      'clear',
                    )
                  }
                >
                  清空
                </Button>
              </div>
            </div>
          </div>
          {bypassScope && <BypassNotice />}
          {resourcesQ.isLoading && <EmptyState text="广告账户加载中" />}
          {!resourcesQ.isLoading && filteredAdAccounts.length === 0 && (
            <EmptyState text="无匹配广告账户" />
          )}
          <div className="divide-y">
            {filteredAdAccounts.map((account) => (
              <AdAccountRow
                key={account.id}
                account={account}
                fbName={fbNameById.get(account.fbAccountId) ?? '未知广告账户组'}
                checked={grantedAdIds.has(account.id)}
                disabled={bypassScope || busy}
                onToggle={() => toggleResource('ad_account', account.id)}
              />
            ))}
          </div>
        </Pane>
      </div>
    </div>
  );
}

function Pane({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-[28rem] flex-col overflow-hidden rounded-md border bg-background lg:min-h-0">
      <div className="border-b p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-medium">{title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {actions && <div className="mt-3">{actions}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 pl-8"
      />
    </div>
  );
}

function FbAccountRow({
  account,
  checked,
  disabled,
  onToggle,
}: {
  account: FbResource;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-md border p-3',
        checked ? 'border-primary bg-primary/5' : 'bg-background hover:bg-muted/50',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{account.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{account.id}</span>
          <StatusBadge status={account.status} />
        </div>
      </div>
    </label>
  );
}

function AdAccountRow({
  account,
  fbName,
  checked,
  disabled,
  onToggle,
}: {
  account: AdResource;
  fbName: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        'grid cursor-pointer grid-cols-[auto_1fr] gap-3 px-3 py-3',
        checked ? 'bg-primary/5' : 'hover:bg-muted/40',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{account.name}</span>
          <StatusBadge status={account.status} />
          {account.currency && <span className="rounded border px-1.5 py-0.5 text-xs">{account.currency}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">act_id: {account.metaActId}</span>
          <span>{fbName}</span>
        </div>
      </div>
    </label>
  );
}

function RoleBadge({ role }: { role: string }) {
  const elevated = BYPASS_ROLES.has(role);
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-0.5 text-xs',
        elevated ? 'border-primary/30 bg-primary/10 text-primary' : 'text-muted-foreground',
      )}
    >
      {role}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const active = ['active', 'success', 'running'].includes(normalized);
  const disabled = ['disabled', 'closed', 'failed', 'token_invalid'].includes(normalized);
  const label =
    normalized === 'token_invalid'
      ? accountGroupStatusLabel(status)
      : normalized === 'pending' || normalized === 'closed'
        ? adAccountStatusLabel(status)
        : userStatusLabel(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs',
        active && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        disabled && 'border-rose-200 bg-rose-50 text-rose-700',
        !active && !disabled && 'text-muted-foreground',
      )}
      >
      {active ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
      {label}
    </span>
  );
}

function BypassNotice() {
  return (
    <div className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1 rounded border bg-background px-2 py-1 text-foreground">
        <ShieldCheck className="h-3 w-3 text-primary" />
        全量自动授权
      </span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex min-h-24 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
      <UserRound className="h-4 w-4" />
      {text}
    </div>
  );
}

function grantKey(resourceType: ResourceType, resourceId: string) {
  return `${resourceType}:${resourceId}`;
}
