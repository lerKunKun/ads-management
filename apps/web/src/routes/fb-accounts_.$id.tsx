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

export const Route = createFileRoute('/fb-accounts_/$id')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: FbAccountAdAccountsPage,
});

function FbAccountAdAccountsPage() {
  const { id } = Route.useParams();
  const fbQ = useQuery({
    queryKey: ['fb-accounts'],
    queryFn: api.fbAccounts,
  });
  const adsQ = useQuery({
    queryKey: ['ad-accounts', id],
    queryFn: () => api.adAccounts(id),
  });

  const fb = fbQ.data?.find((f) => f.id === id);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [currency, setCurrency] = useState('');

  const currencyOptions = useMemo(() => {
    const set = new Set<string>();
    (adsQ.data ?? []).forEach((a) => {
      if (a.currency) set.add(a.currency);
    });
    return [
      { value: '', label: '全部' },
      ...Array.from(set).sort().map((c) => ({ value: c, label: c })),
    ];
  }, [adsQ.data]);

  const filtered = useMemo(() => {
    const all = adsQ.data ?? [];
    return all.filter(
      (a) =>
        (matchText(a.name, search) || matchText(a.metaActId, search)) &&
        (!status || a.status === status) &&
        (!currency || a.currency === currency),
    );
  }, [adsQ.data, search, status, currency]);

  return (
    <div>
      <div className="text-sm text-muted-foreground mb-2">
        <Link to="/fb-accounts" className="hover:text-foreground">
          ← FB 个号
        </Link>
      </div>
      <div className="mb-4">
        <h1 className="text-xl font-semibold">{fb?.name ?? '…'}</h1>
        <p className="text-sm text-muted-foreground">
          {fb?.fbUserId} · 状态 {fb?.status}
        </p>
      </div>

      {adsQ.error && (
        <p className="text-sm text-destructive mb-2">{(adsQ.error as Error).message}</p>
      )}

      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium">广告账户</h2>
        <Button size="sm" variant="outline" onClick={() => adsQ.refetch()}>
          刷新
        </Button>
      </div>

      <div className="mb-3">
        <SearchFilterBar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="搜索名称 / Meta 账户 ID…"
          filters={[
            {
              key: 'status',
              label: '状态',
              value: status,
              onChange: setStatus,
              options: [
                { value: '', label: '全部' },
                { value: 'active', label: 'active' },
                { value: 'pending', label: 'pending' },
                { value: 'disabled', label: 'disabled' },
                { value: 'closed', label: 'closed' },
              ],
            },
            {
              key: 'currency',
              label: '币种',
              value: currency,
              onChange: setCurrency,
              options: currencyOptions,
            },
          ]}
          total={adsQ.data?.length ?? 0}
          filtered={filtered.length}
          onReset={() => {
            setSearch('');
            setStatus('');
            setCurrency('');
          }}
        />
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Meta 账户 ID</TableHead>
              <TableHead>币种</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>最后同步</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adsQ.isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  无广告账户
                </TableCell>
              </TableRow>
            )}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  无匹配项
                </TableCell>
              </TableRow>
            )}
            {filtered.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/ad-accounts/$id"
                    params={{ id: a.id }}
                    className="text-primary hover:underline"
                  >
                    {a.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{a.metaActId}</TableCell>
                <TableCell>{a.currency ?? '-'}</TableCell>
                <TableCell
                  className={
                    a.status === 'active'
                      ? 'text-emerald-600'
                      : a.status === 'pending'
                        ? 'text-amber-600'
                        : 'text-rose-600'
                  }
                >
                  {a.status}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
