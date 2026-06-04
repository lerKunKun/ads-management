import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Search,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  api,
  getToken,
  type PermissionApprovalRequest,
  type PermissionApprovalStatus,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { adAccountStatusLabel } from '@/lib/labels';

export const Route = createFileRoute('/admin_/iam-approvals')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: IamApprovalsPage,
});

const STATUS_OPTIONS: Array<{ value: PermissionApprovalStatus | 'all'; label: string }> = [
  { value: 'pending', label: '待审批' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'all', label: '全部' },
];

const STATUS_LABEL: Record<PermissionApprovalStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已拒绝',
  cancelled: '已取消',
};

function IamApprovalsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<PermissionApprovalStatus | 'all'>('pending');
  const [selectedId, setSelectedId] = useState('');
  const [selectedAdIds, setSelectedAdIds] = useState<string[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const [search, setSearch] = useState('');

  const requestsQ = useQuery({
    queryKey: ['admin', 'permission-approvals', status],
    queryFn: () => api.listPermissionApprovalRequests(status === 'all' ? undefined : status),
  });

  const requests = requestsQ.data ?? [];
  const filteredRequests = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return requests;
    return requests.filter((request) =>
      [
        request.requesterEmail,
        request.fbAccountName,
        request.status,
        request.adAccounts.map((account) => `${account.name} ${account.metaActId}`).join(' '),
      ].some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [requests, search]);
  const selectedRequest =
    filteredRequests.find((request) => request.id === selectedId) ?? filteredRequests[0] ?? null;

  useEffect(() => {
    if (!selectedRequest) {
      setSelectedId('');
      return;
    }
    if (selectedRequest.id !== selectedId) setSelectedId(selectedRequest.id);
  }, [selectedId, selectedRequest]);

  useEffect(() => {
    if (!selectedRequest) {
      setSelectedAdIds([]);
      setReviewNote('');
      return;
    }
    setSelectedAdIds(
      selectedRequest.status === 'pending'
        ? selectedRequest.requestedAdAccountIds
        : selectedRequest.approvedAdAccountIds,
    );
    setReviewNote(selectedRequest.reviewNote ?? '');
  }, [selectedRequest?.id, selectedRequest?.status]);

  const reviewMutation = useMutation({
    mutationFn: (args: {
      id: string;
      status: 'approved' | 'rejected';
      approvedAdAccountIds?: string[];
      reviewNote?: string;
    }) =>
      api.reviewPermissionApprovalRequest(args.id, {
        status: args.status,
        approvedAdAccountIds: args.approvedAdAccountIds,
        reviewNote: args.reviewNote,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'permission-approvals'] });
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      qc.invalidateQueries({ queryKey: ['permission-approval'] });
    },
  });

  const selectedSet = useMemo(() => new Set(selectedAdIds), [selectedAdIds]);
  const pending = selectedRequest?.status === 'pending';
  const busy = reviewMutation.isPending || requestsQ.isFetching;
  const error =
    (requestsQ.error as Error | null)?.message ??
    (reviewMutation.error as Error | null)?.message;

  function toggleAdAccount(id: string) {
    if (!pending || busy) return;
    setSelectedAdIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function approveAll(request: PermissionApprovalRequest) {
    reviewMutation.mutate({
      id: request.id,
      status: 'approved',
      approvedAdAccountIds: request.requestedAdAccountIds,
      reviewNote: reviewNote.trim() || undefined,
    });
  }

  function approveSelected(request: PermissionApprovalRequest) {
    reviewMutation.mutate({
      id: request.id,
      status: 'approved',
      approvedAdAccountIds: selectedAdIds,
      reviewNote: reviewNote.trim() || undefined,
    });
  }

  function rejectRequest(request: PermissionApprovalRequest) {
    reviewMutation.mutate({
      id: request.id,
      status: 'rejected',
      reviewNote: reviewNote.trim() || undefined,
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm text-muted-foreground">
            <Link to="/admin" className="hover:text-foreground">
              返回管理中心
            </Link>
          </div>
          <h1 className="mt-1 text-xl font-semibold">权限审批</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_OPTIONS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={status === option.value ? 'default' : 'outline'}
              onClick={() => setStatus(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:h-[calc(100vh-10rem)] lg:grid-cols-[24rem_1fr]">
        <section className="flex min-h-[28rem] flex-col overflow-hidden rounded-md border bg-background lg:min-h-0">
          <div className="border-b p-3">
            <div className="flex items-center gap-2 font-medium">
              <ClipboardCheck className="h-4 w-4 text-primary" />
              申请列表
            </div>
            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-9 pl-8"
                placeholder="搜索申请人 / FB 个号 / 广告账户"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {requestsQ.isLoading && <EmptyState text="加载中..." />}
            {!requestsQ.isLoading && filteredRequests.length === 0 && (
              <EmptyState text="暂无审批申请" />
            )}
            {filteredRequests.map((request) => (
              <button
                key={request.id}
                type="button"
                className={cn(
                  'mb-2 w-full rounded-md border p-3 text-left last:mb-0 hover:bg-muted/50',
                  selectedRequest?.id === request.id && 'border-primary bg-primary/5',
                )}
                onClick={() => setSelectedId(request.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{request.requesterEmail}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {request.fbAccountName}
                    </div>
                  </div>
                  <ApprovalStatusBadge status={request.status} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>申请 {request.requestedAdAccountIds.length} 个</span>
                  <span>{new Date(request.createdAt).toLocaleString()}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="flex min-h-[32rem] flex-col overflow-hidden rounded-md border bg-background lg:min-h-0">
          {!selectedRequest && <EmptyState text="请选择审批申请" />}
          {selectedRequest && (
            <>
              <div className="border-b p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-medium">{selectedRequest.fbAccountName}</h2>
                      <ApprovalStatusBadge status={selectedRequest.status} />
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      申请人 {selectedRequest.requesterEmail} /{' '}
                      {new Date(selectedRequest.createdAt).toLocaleString()}
                    </div>
                  </div>
                  {pending && (
                    <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:flex">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setSelectedAdIds(selectedRequest.requestedAdAccountIds)}
                      >
                        全选
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || selectedAdIds.length === 0}
                        onClick={() => setSelectedAdIds([])}
                      >
                        清空
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => approveAll(selectedRequest)}
                      >
                        一键通过
                      </Button>
                    </div>
                  )}
                </div>
                {selectedRequest.note && (
                  <p className="mt-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    申请备注：{selectedRequest.note}
                  </p>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto divide-y">
                {selectedRequest.adAccounts.map((account) => (
                  <label
                    key={account.id}
                    className={cn(
                      'grid grid-cols-[auto_1fr] gap-3 px-3 py-3',
                      pending ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default',
                      selectedSet.has(account.id) && 'bg-primary/5',
                      account.alreadyGranted && pending && 'opacity-70',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={selectedSet.has(account.id)}
                      disabled={!pending || busy}
                      onChange={() => toggleAdAccount(account.id)}
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-words text-sm font-medium">{account.name}</span>
                        <span className="rounded border px-1.5 py-0.5 text-xs">
                          {adAccountStatusLabel(account.status)}
                        </span>
                        {account.alreadyGranted && (
                          <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                            已有授权
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        act_id: <span className="font-mono">{account.metaActId}</span>
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              <div className="border-t bg-muted/20 p-3">
                <label className="block text-sm font-medium" htmlFor="review-note">
                  审批备注
                </label>
                <textarea
                  id="review-note"
                  value={reviewNote}
                  disabled={!pending}
                  onChange={(event) => setReviewNote(event.target.value)}
                  rows={3}
                  className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none disabled:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="可填写通过或拒绝原因"
                />
                {selectedRequest.reviewedAt && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    审批人 {selectedRequest.reviewerEmail ?? '-'} /{' '}
                    {new Date(selectedRequest.reviewedAt).toLocaleString()}
                  </p>
                )}
                {pending && (
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || selectedAdIds.length === 0}
                      onClick={() => approveSelected(selectedRequest)}
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {reviewMutation.isPending ? '处理中...' : '通过所选'}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => rejectRequest(selectedRequest)}
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      拒绝
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ApprovalStatusBadge({ status }: { status: PermissionApprovalStatus }) {
  const Icon = status === 'approved' ? CheckCircle2 : status === 'rejected' ? XCircle : Clock3;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs',
        status === 'approved' && 'border-emerald-200 bg-emerald-50 text-emerald-700',
        status === 'pending' && 'border-amber-200 bg-amber-50 text-amber-700',
        status === 'rejected' && 'border-rose-200 bg-rose-50 text-rose-700',
        status === 'cancelled' && 'text-muted-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      {STATUS_LABEL[status]}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="flex min-h-24 items-center justify-center p-4 text-sm text-muted-foreground">{text}</div>;
}
