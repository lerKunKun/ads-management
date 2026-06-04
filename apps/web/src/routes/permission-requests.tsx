import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  History,
  KeyRound,
  Search,
  Send,
  XCircle,
} from 'lucide-react';
import { api, getToken, type PermissionApprovalStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { adAccountStatusLabel, accountGroupStatusLabel } from '@/lib/labels';
import {
  createFbAccountNameMap,
  filterFbNameDuplicateAdAccounts,
} from '@/lib/ad-account-display';

export const Route = createFileRoute('/permission-requests')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: PermissionRequestsPage,
});

const APPROVAL_STATUS_LABEL: Record<PermissionApprovalStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已拒绝',
  cancelled: '已取消',
};

function PermissionRequestsPage() {
  const qc = useQueryClient();
  const resourcesQ = useQuery({
    queryKey: ['permission-approval', 'resources'],
    queryFn: api.myPermissionApprovalResources,
  });
  const historyQ = useQuery({
    queryKey: ['permission-approval', 'mine'],
    queryFn: api.myPermissionApprovalRequests,
  });
  const [selectedFbId, setSelectedFbId] = useState('');
  const [selectedAdIds, setSelectedAdIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [note, setNote] = useState('');

  const fbAccounts = resourcesQ.data?.fbAccounts ?? [];
  const rawAdAccounts = resourcesQ.data?.adAccounts ?? [];
  const fbNameById = useMemo(() => createFbAccountNameMap(fbAccounts), [fbAccounts]);
  const adAccounts = useMemo(
    () => filterFbNameDuplicateAdAccounts(rawAdAccounts, fbNameById),
    [fbNameById, rawAdAccounts],
  );

  useEffect(() => {
    if (fbAccounts.length === 0) {
      setSelectedFbId('');
      return;
    }
    if (!selectedFbId || !fbAccounts.some((account) => account.id === selectedFbId)) {
      setSelectedFbId(fbAccounts[0]!.id);
    }
  }, [fbAccounts, selectedFbId]);

  const selectedFb = fbAccounts.find((account) => account.id === selectedFbId) ?? null;
  const scopedAdAccounts = useMemo(
    () => adAccounts.filter((account) => account.fbAccountId === selectedFbId),
    [adAccounts, selectedFbId],
  );
  const filteredAdAccounts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return scopedAdAccounts;
    return scopedAdAccounts.filter((account) =>
      [account.name, account.metaActId, account.status, account.currency ?? ''].some((value) =>
        value.toLowerCase().includes(keyword),
      ),
    );
  }, [scopedAdAccounts, search]);
  const selectableIds = useMemo(
    () =>
      filteredAdAccounts
        .filter((account) => !account.granted && !account.pending)
        .map((account) => account.id),
    [filteredAdAccounts],
  );
  const selectedSet = useMemo(() => new Set(selectedAdIds), [selectedAdIds]);
  const selectedGroups = useMemo(() => {
    const accountById = new Map(adAccounts.map((account) => [account.id, account]));
    const groups = new Map<string, string[]>();
    for (const id of selectedAdIds) {
      const account = accountById.get(id);
      if (!account) continue;
      const ids = groups.get(account.fbAccountId) ?? [];
      ids.push(id);
      groups.set(account.fbAccountId, ids);
    }
    return Array.from(groups, ([fbAccountId, adAccountIds]) => ({ fbAccountId, adAccountIds }));
  }, [adAccounts, selectedAdIds]);
  const selectedCountByFb = useMemo(
    () => new Map(selectedGroups.map((group) => [group.fbAccountId, group.adAccountIds.length])),
    [selectedGroups],
  );
  const currentFbSelectedCount = selectedCountByFb.get(selectedFbId) ?? 0;
  const visibleSelectedCount = selectableIds.filter((id) => selectedSet.has(id)).length;

  const submitMutation = useMutation({
    mutationFn: async () => {
      const noteText = note.trim() || undefined;
      const results = [];
      for (const group of selectedGroups) {
        results.push(
          await api.submitPermissionApprovalRequest({
            fbAccountId: group.fbAccountId,
            adAccountIds: group.adAccountIds,
            note: noteText,
          }),
        );
      }
      return results;
    },
    onSuccess: () => {
      setSelectedAdIds([]);
      setNote('');
      qc.invalidateQueries({ queryKey: ['permission-approval'] });
    },
  });

  function toggleAdAccount(id: string) {
    setSelectedAdIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function selectAllVisible() {
    setSelectedAdIds((current) => Array.from(new Set([...current, ...selectableIds])));
  }

  function clearVisible() {
    const visible = new Set(selectableIds);
    setSelectedAdIds((current) => current.filter((id) => !visible.has(id)));
  }

  const error =
    (resourcesQ.error as Error | null)?.message ??
    (historyQ.error as Error | null)?.message ??
    (submitMutation.error as Error | null)?.message;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">权限申请</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选择已授权 FB 个号下的广告账户，提交后等待管理员审批。
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/ad-accounts">返回广告账户</Link>
        </Button>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <section className="overflow-hidden rounded-md border bg-background">
          <div className="border-b px-3 py-3">
            <div className="flex items-center gap-2 font-medium">
              <KeyRound className="h-4 w-4 text-primary" />
              FB 个号
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{fbAccounts.length} 个可申请来源</p>
          </div>
          {resourcesQ.isLoading && <EmptyState text="加载中..." />}
          {!resourcesQ.isLoading && fbAccounts.length === 0 && (
            <EmptyState text="暂无已授权给你的 FB 个号" />
          )}
          <div className="max-h-[28rem] overflow-y-auto p-2">
            {fbAccounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className={cn(
                  'mb-2 w-full rounded-md border p-3 text-left last:mb-0 hover:bg-muted/50',
                  selectedFbId === account.id && 'border-primary bg-primary/5',
                )}
                onClick={() => setSelectedFbId(account.id)}
              >
                <div className="truncate text-sm font-medium">{account.name}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{accountGroupStatusLabel(account.status)}</span>
                  <span>{account.adAccountCount} 个广告账户</span>
                  {(selectedCountByFb.get(account.id) ?? 0) > 0 && (
                    <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary">
                      已选 {selectedCountByFb.get(account.id)} 个
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-md border bg-background">
          <div className="border-b px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-medium">广告账户</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedFb ? selectedFb.name : '请选择 FB 个号'} / 当前已选{' '}
                  {currentFbSelectedCount} 个 / 全部已选 {selectedAdIds.length} 个
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={selectableIds.length === 0}
                  onClick={selectAllVisible}
                >
                  全选当前
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={visibleSelectedCount === 0}
                  onClick={clearVisible}
                >
                  清空当前
                </Button>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索名称 / act_id"
                  className="h-9 pl-8"
                />
              </div>
            </div>
          </div>

          {resourcesQ.isLoading && <EmptyState text="加载中..." />}
          {!resourcesQ.isLoading && selectedFb && filteredAdAccounts.length === 0 && (
            <EmptyState text="暂无可展示广告账户" />
          )}
          <div className="max-h-[32rem] divide-y overflow-y-auto">
            {filteredAdAccounts.map((account) => {
              const disabled = account.granted || account.pending || submitMutation.isPending;
              return (
                <label
                  key={account.id}
                  className={cn(
                    'grid cursor-pointer grid-cols-[auto_1fr] gap-3 px-3 py-3 hover:bg-muted/40',
                    selectedSet.has(account.id) && 'bg-primary/5',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={selectedSet.has(account.id)}
                    disabled={disabled}
                    onChange={() => toggleAdAccount(account.id)}
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-sm font-medium">{account.name}</span>
                      <span className="rounded border px-1.5 py-0.5 text-xs">
                        {adAccountStatusLabel(account.status)}
                      </span>
                      {account.granted && (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                          已授权
                        </span>
                      )}
                      {account.pending && (
                        <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                          审批中
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">act_id: {account.metaActId}</span>
                      {account.currency && <span>{account.currency}</span>}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="border-t bg-muted/20 p-3">
            <label className="block text-sm font-medium" htmlFor="approval-note">
              备注
            </label>
            <textarea
              id="approval-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="可填写用途或投放需求"
            />
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                disabled={selectedGroups.length === 0 || submitMutation.isPending}
                onClick={() => submitMutation.mutate()}
              >
                <Send className="mr-2 h-4 w-4" />
                {submitMutation.isPending ? '提交中...' : '提交审批'}
              </Button>
            </div>
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-md border bg-background">
        <div className="flex items-center gap-2 border-b px-3 py-3 font-medium">
          <History className="h-4 w-4 text-primary" />
          我的申请记录
        </div>
        {historyQ.isLoading && <EmptyState text="加载中..." />}
        {!historyQ.isLoading && (historyQ.data ?? []).length === 0 && (
          <EmptyState text="暂无申请记录" />
        )}
        <div className="divide-y">
          {(historyQ.data ?? []).map((request) => (
            <div key={request.id} className="px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{request.fbAccountName}</span>
                    <ApprovalStatusBadge status={request.status} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {new Date(request.createdAt).toLocaleString()} / 申请{' '}
                    {request.requestedAdAccountIds.length} 个，通过{' '}
                    {request.approvedAdAccountIds.length} 个
                  </div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {request.adAccounts.map((account) => (
                  <span key={account.id} className="rounded border px-2 py-1 text-xs">
                    {account.name}
                  </span>
                ))}
              </div>
              {request.reviewNote && (
                <p className="mt-2 text-sm text-muted-foreground">审批备注：{request.reviewNote}</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ApprovalStatusBadge({ status }: { status: PermissionApprovalStatus }) {
  const Icon = status === 'approved' ? CheckCircle2 : status === 'rejected' ? XCircle : Clock3;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs',
        status === 'approved' && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        status === 'pending' && 'border-amber-200 bg-amber-50 text-amber-700',
        status === 'rejected' && 'border-rose-200 bg-rose-50 text-rose-700',
        status === 'cancelled' && 'text-muted-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      {APPROVAL_STATUS_LABEL[status]}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="flex min-h-24 items-center justify-center p-4 text-sm text-muted-foreground">{text}</div>;
}
