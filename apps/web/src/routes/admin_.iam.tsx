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
import { api, getToken, setToken, type Me } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { accountGroupStatusLabel, adAccountStatusLabel, userStatusLabel } from '@/lib/labels';
import {
  createFbAccountNameMap,
  filterFbNameDuplicateAdAccounts,
  isFbNameDuplicateAdAccount,
} from '@/lib/ad-account-display';

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

type DraftScope = {
  userId: string;
  fbAccountIds: string[];
  adAccountIds: string[];
};

const BYPASS_ROLES = new Set(['CompanyAdmin', 'PlatformAdmin']);

function IamWorkspacePage() {
  const routeSearch = Route.useSearch();
  const qc = useQueryClient();
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const companiesQ = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: api.listCompanies,
    enabled: me.data?.permissions.includes('iam:manage') ?? false,
  });
  const usersQ = useQuery({ queryKey: ['admin', 'users'], queryFn: api.listUsers });
  const resourcesQ = useQuery({
    queryKey: ['admin', 'grant-resources'],
    queryFn: api.listGrantResources,
  });

  const [selectedUserId, setSelectedUserId] = useState(routeSearch.userId ?? '');
  const [userSearch, setUserSearch] = useState('');
  const [fbSearch, setFbSearch] = useState('');
  const [adSearch, setAdSearch] = useState('');
  const [draftScope, setDraftScope] = useState<DraftScope | null>(null);
  const canSwitchCompany = me.data?.roles.includes('PlatformAdmin') ?? false;

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
  const switchCompany = useMutation({
    mutationFn: (companyId: string) => api.switchCompany(companyId),
    onSuccess: (result) => {
      setToken(result.token);
      setSelectedUserId('');
      qc.clear();
    },
  });

  const grants = grantsQ.data ?? [];
  const savedFbIds = useMemo(
    () =>
      new Set(
        grants
          .filter((grant) => grant.resourceType === 'fb_account')
          .map((grant) => grant.resourceId),
      ),
    [grants],
  );
  const savedAdIds = useMemo(
    () =>
      new Set(
        grants
          .filter((grant) => grant.resourceType === 'ad_account')
          .map((grant) => grant.resourceId),
      ),
    [grants],
  );

  useEffect(() => {
    if (!selectedUser) {
      setDraftScope(null);
      return;
    }
    if (!grantsQ.data) return;
    setDraftScope({
      userId: selectedUser.id,
      fbAccountIds: grantsQ.data
        .filter((grant) => grant.resourceType === 'fb_account')
        .map((grant) => grant.resourceId),
      adAccountIds: grantsQ.data
        .filter((grant) => grant.resourceType === 'ad_account')
        .map((grant) => grant.resourceId),
    });
  }, [grantsQ.data, selectedUser?.id]);

  const draftReady = !!selectedUser && !!grantsQ.data && draftScope?.userId === selectedUser.id;
  const draftFbIds = useMemo(
    () => new Set(draftReady ? draftScope.fbAccountIds : []),
    [draftReady, draftScope],
  );
  const draftAdIds = useMemo(
    () => new Set(draftReady ? draftScope.adAccountIds : []),
    [draftReady, draftScope],
  );

  const fbAccounts = resourcesQ.data?.fbAccounts ?? [];
  const rawAdAccounts = resourcesQ.data?.adAccounts ?? [];
  const fbNameById = useMemo(() => {
    return createFbAccountNameMap(fbAccounts);
  }, [fbAccounts]);
  const adAccounts = useMemo(
    () => filterFbNameDuplicateAdAccounts(rawAdAccounts, fbNameById),
    [fbNameById, rawAdAccounts],
  );
  const visibleAdAccountIds = useMemo(
    () => new Set(adAccounts.map((account) => account.id)),
    [adAccounts],
  );
  const visibleDraftAdCount = useMemo(
    () => Array.from(draftAdIds).filter((id) => visibleAdAccountIds.has(id)).length,
    [draftAdIds, visibleAdAccountIds],
  );

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
      draftFbIds.size === 0
        ? adAccounts
        : adAccounts.filter((account) => draftFbIds.has(account.fbAccountId)),
    [adAccounts, draftFbIds],
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
  const busy = grantMutation.isPending || grantsQ.isFetching;
  const draftChangeCount = useMemo(() => {
    if (!draftReady) return 0;
    return countSetDiff(savedFbIds, draftFbIds) + countSetDiff(savedAdIds, draftAdIds);
  }, [draftAdIds, draftFbIds, draftReady, savedAdIds, savedFbIds]);
  const hasDraftChanges = draftChangeCount > 0;

  function toggleResource(resourceType: ResourceType, resourceId: string) {
    if (!selectedUser || bypassScope || busy || !draftReady) return;
    updateDraftResource(resourceType, (ids) => {
      const next = new Set(ids);
      if (next.has(resourceId)) {
        next.delete(resourceId);
      } else {
        next.add(resourceId);
      }
      return Array.from(next);
    });
  }

  function bulkChange(
    resourceType: ResourceType,
    resourceIds: string[],
    mode: 'select' | 'clear' | 'invert',
  ) {
    if (!selectedUser || bypassScope || busy || !draftReady) return;
    updateDraftResource(resourceType, (ids) => {
      const next = new Set(ids);
      for (const resourceId of resourceIds) {
        if (mode === 'select') next.add(resourceId);
        if (mode === 'clear') next.delete(resourceId);
        if (mode === 'invert') {
          if (next.has(resourceId)) next.delete(resourceId);
          else next.add(resourceId);
        }
      }
      return Array.from(next);
    });
  }

  function updateDraftResource(
    resourceType: ResourceType,
    updater: (ids: string[]) => string[],
  ) {
    setDraftScope((current) => {
      if (!selectedUser || current?.userId !== selectedUser.id) return current;
      if (resourceType === 'fb_account') {
        const previousFbIds = new Set(current.fbAccountIds);
        const nextFbAccountIds = updater(current.fbAccountIds);
        const nextFbIds = new Set(nextFbAccountIds);
        const nextAdIds = new Set(current.adAccountIds);

        for (const account of rawAdAccounts) {
          const wasSelectedGroup = previousFbIds.has(account.fbAccountId);
          const isSelectedGroup = nextFbIds.has(account.fbAccountId);
          if (
            !wasSelectedGroup &&
            isSelectedGroup &&
            !isFbNameDuplicateAdAccount(account, fbNameById)
          ) {
            nextAdIds.add(account.id);
          }
          if (wasSelectedGroup && !isSelectedGroup) nextAdIds.delete(account.id);
        }

        return {
          ...current,
          fbAccountIds: nextFbAccountIds,
          adAccountIds: Array.from(nextAdIds),
        };
      }
      return { ...current, adAccountIds: updater(current.adAccountIds) };
    });
  }

  function buildGrantOps(): GrantChange[] {
    if (!selectedUser || !draftReady) return [];
    const ops: GrantChange[] = [];
    for (const resourceId of draftFbIds) {
      if (!savedFbIds.has(resourceId)) {
        ops.push({ action: 'add', resourceType: 'fb_account', resourceId });
      }
    }
    for (const resourceId of draftAdIds) {
      if (!savedAdIds.has(resourceId)) {
        ops.push({ action: 'add', resourceType: 'ad_account', resourceId });
      }
    }
    for (const grant of grants) {
      if (grant.resourceType === 'fb_account' && !draftFbIds.has(grant.resourceId)) {
        ops.push({ action: 'remove', grantId: grant.id });
      }
      if (grant.resourceType === 'ad_account' && !draftAdIds.has(grant.resourceId)) {
        ops.push({ action: 'remove', grantId: grant.id });
      }
    }
    return ops;
  }

  function saveDraft() {
    if (!selectedUser || bypassScope || busy || !hasDraftChanges) return;
    const ops = buildGrantOps();
    if (ops.length > 0) grantMutation.mutate({ userId: selectedUser.id, ops });
  }

  function cancelDraft() {
    if (!selectedUser || !grantsQ.data) return;
    setDraftScope({
      userId: selectedUser.id,
      fbAccountIds: Array.from(savedFbIds),
      adAccountIds: Array.from(savedAdIds),
    });
  }

  function selectUser(userId: string) {
    if (busy || (hasDraftChanges && selectedUser?.id !== userId)) return;
    setSelectedUserId(userId);
  }

  const error =
    (me.error as Error | null)?.message ??
    (companiesQ.error as Error | null)?.message ??
    (usersQ.error as Error | null)?.message ??
    (resourcesQ.error as Error | null)?.message ??
    (grantsQ.error as Error | null)?.message ??
    (grantMutation.error as Error | null)?.message ??
    (switchCompany.error as Error | null)?.message;

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
        <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <select
            value={me.data?.companyId ?? ''}
            disabled={!canSwitchCompany || switchCompany.isPending || busy || hasDraftChanges}
            onChange={(event) => switchCompany.mutate(event.currentTarget.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm disabled:bg-muted sm:min-w-72 sm:flex-none"
          >
            {(companiesQ.data ?? []).length === 0 && (
              <option value={me.data?.companyId ?? ''}>
                当前公司 {me.data?.companyName ?? '加载中'}
              </option>
            )}
            {(companiesQ.data ?? []).map((company) => (
              <option key={company.id} value={company.id}>
                {company.name} {company.id === me.data?.companyId ? '（当前）' : ''}
              </option>
            ))}
          </select>
          {!canSwitchCompany && (
            <span className="text-xs text-muted-foreground">仅超管可切换</span>
          )}
          {hasDraftChanges && (
            <span className="text-xs text-amber-600">{draftChangeCount} 项未保存</span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="flex-1 sm:flex-none"
            disabled={!hasDraftChanges || busy}
            onClick={cancelDraft}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="flex-1 sm:flex-none"
            disabled={!hasDraftChanges || bypassScope || busy}
            onClick={saveDraft}
          >
            {grantMutation.isPending ? '保存中...' : '确定'}
          </Button>
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
              placeholder="搜索账号或角色"
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
                disabled={busy || (hasDraftChanges && selectedUser?.id !== user.id)}
                onClick={() => selectUser(user.id)}
                className={cn(
                  'w-full rounded-md border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
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
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <StatusBadge status={user.status} />
                      <span>
                        已授权FB个人号{' '}
                        {selectedUser?.id === user.id && draftReady
                          ? draftFbIds.size
                          : user.fbAccountGrantCount}
                      </span>
                      <span>
                        广告账户{' '}
                        {selectedUser?.id === user.id && draftReady
                          ? draftAdIds.size
                          : user.adAccountGrantCount}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Pane>

        <Pane
          title="FB个人号"
          subtitle={`${draftFbIds.size} / ${fbAccounts.length} 已选择`}
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
                disabled={bypassScope || busy || draftFbIds.size === 0}
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
          {resourcesQ.isLoading && <EmptyState text="FB个人号加载中" />}
          {!resourcesQ.isLoading && filteredFbAccounts.length === 0 && (
            <EmptyState text="无匹配FB个人号" />
          )}
          <div className="space-y-2 p-3">
            {filteredFbAccounts.map((account) => (
              <FbAccountRow
                key={account.id}
                account={account}
                checked={draftFbIds.has(account.id)}
                disabled={bypassScope || busy}
                onToggle={() => toggleResource('fb_account', account.id)}
              />
            ))}
          </div>
        </Pane>

        <Pane
          title="广告账户"
          subtitle={`${visibleDraftAdCount} / ${adAccounts.length} 已选择`}
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
                {draftFbIds.size > 0 ? `，受 ${draftFbIds.size} 个FB个人号过滤` : ''}
              </div>
              <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
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
                  disabled={bypassScope || busy || draftAdIds.size === 0}
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
                fbName={fbNameById.get(account.fbAccountId) ?? '未知FB个人号'}
                checked={draftAdIds.has(account.id)}
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
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 w-full pl-8"
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

function countSetDiff(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (!right.has(value)) count += 1;
  }
  for (const value of right) {
    if (!left.has(value)) count += 1;
  }
  return count;
}
