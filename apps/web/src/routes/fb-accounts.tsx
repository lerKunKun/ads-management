import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Unlink } from 'lucide-react';
import { api, getToken, type FbAccount } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';
import { Pagination, usePagination } from '@/components/Pagination';
import { accountGroupStatusLabel } from '@/lib/labels';

export const Route = createFileRoute('/fb-accounts')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: FbAccountsPage,
});

const STATUS_COLOR: Record<string, string> = {
  active: 'text-emerald-600',
  token_invalid: 'text-rose-600',
  disabled: 'text-rose-600',
};

function FbAccountsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['fb-accounts'],
    queryFn: api.fbAccounts,
  });

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [unlinkTarget, setUnlinkTarget] = useState<FbAccount | null>(null);

  const unlinkFb = useMutation({
    mutationFn: (id: string) => api.unbindFbAccount(id),
    onSuccess: () => {
      setUnlinkTarget(null);
      qc.invalidateQueries({ queryKey: ['fb-accounts'] });
      qc.invalidateQueries({ queryKey: ['ad-accounts'] });
    },
  });

  const filtered = useMemo(() => {
    const all = data ?? [];
    return all.filter(
      (f) =>
        (matchText(f.name, search) || matchText(f.fbUserId, search)) &&
        (!status || f.status === status),
    );
  }, [data, search, status]);
  const pager = usePagination(filtered);

  async function bindFb() {
    try {
      const r = await api.fbAuthorizeUrl();
      window.location.href = r.authorize_url;
    } catch (e) {
      alert(`获取授权链接失败: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">FB个人号</h1>
          <p className="text-sm text-muted-foreground">
            点击FB个人号名称进入其下广告账户。
          </p>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => refetch()}>
            刷新
          </Button>
          <Button size="sm" className="w-full sm:w-auto" onClick={bindFb}>
            绑定FB个人号
          </Button>
        </div>
      </div>

      {(error || unlinkFb.error) && (
        <p className="text-sm text-destructive mb-2">
          {((error ?? unlinkFb.error) as Error).message}
        </p>
      )}

      <div className="mb-3">
        <SearchFilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索组名称 / 绑定账号 ID…"
          filters={[
            {
              key: 'status',
              label: '状态',
              value: status,
              onChange: setStatus,
              options: [
                { value: '', label: '全部' },
                { value: 'active', label: accountGroupStatusLabel('active') },
                { value: 'token_invalid', label: accountGroupStatusLabel('token_invalid') },
                { value: 'disabled', label: accountGroupStatusLabel('disabled') },
              ],
            },
          ]}
          total={data?.length ?? 0}
          filtered={filtered.length}
          onReset={() => {
            setSearch('');
            setStatus('');
          }}
        />
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>绑定账号 ID</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>广告账户数</TableHead>
              <TableHead>Token 到期</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (data?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  尚未绑定FB个人号
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (data?.length ?? 0) > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  无匹配项
                </TableCell>
              </TableRow>
            )}
            {pager.pageItems.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/fb-accounts/$id"
                    params={{ id: f.id }}
                    className="text-primary hover:underline"
                  >
                    {f.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{f.fbUserId}</TableCell>
                <TableCell className={STATUS_COLOR[f.status] ?? ''}>
                  {accountGroupStatusLabel(f.status)}
                </TableCell>
                <TableCell>{f.adAccountCount}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {f.tokenExpiresAt ? new Date(f.tokenExpiresAt).toLocaleString() : '-'}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={unlinkFb.isPending}
                    onClick={() => setUnlinkTarget(f)}
                  >
                    <Unlink className="mr-1 h-3 w-3" />
                    解绑
                  </Button>
                </TableCell>
              </TableRow>
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
      <UnbindFbAccountDialog
        account={unlinkTarget}
        submitting={unlinkFb.isPending}
        onCancel={() => setUnlinkTarget(null)}
        onConfirm={() => unlinkTarget && unlinkFb.mutate(unlinkTarget.id)}
      />
    </div>
  );
}

function UnbindFbAccountDialog({
  account,
  submitting,
  onCancel,
  onConfirm,
}: {
  account: FbAccount | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!account} onOpenChange={(nextOpen) => !nextOpen && onCancel()} title="解绑FB个人号">
      <div className="space-y-2 text-sm">
        <p>
          确定解绑 {account?.name ?? '该FB个人号'} 吗？
        </p>
        <p className="text-muted-foreground">
          解绑后会从系统移除该个户及其下 {account?.adAccountCount ?? 0} 个广告账户。
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={submitting || !account}>
          {submitting ? '解绑中...' : '确认解绑'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
