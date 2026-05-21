import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, getToken } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
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
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['fb-accounts'],
    queryFn: api.fbAccounts,
  });

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

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
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">广告账户组</h1>
          <p className="text-sm text-muted-foreground">
            点击账户组名称进入组内广告账户。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            刷新
          </Button>
          <Button size="sm" onClick={bindFb}>
            绑定广告账户组
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive mb-2">{(error as Error).message}</p>
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

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>绑定账号 ID</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>广告账户数</TableHead>
              <TableHead>Token 到期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (data?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  尚未绑定广告账户组
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (data?.length ?? 0) > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
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
    </div>
  );
}
