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
import { accountGroupStatusLabel, adAccountStatusLabel } from '@/lib/labels';

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
  const [timezone, setTimezone] = useState('');
  const [country, setCountry] = useState('');

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

  const timezoneOptions = useMemo(() => {
    const set = new Set<string>();
    (adsQ.data ?? []).forEach((a) => {
      if (a.timezoneName) set.add(a.timezoneName);
    });
    return [
      { value: '', label: '全部' },
      ...Array.from(set).sort().map((value) => ({ value, label: value })),
    ];
  }, [adsQ.data]);

  const countryOptions = useMemo(() => {
    const set = new Set<string>();
    (adsQ.data ?? []).forEach((a) => {
      if (a.businessCountryCode) set.add(a.businessCountryCode);
    });
    return [
      { value: '', label: '全部' },
      ...Array.from(set).sort().map((value) => ({ value, label: countryLabel(value) })),
    ];
  }, [adsQ.data]);

  const filtered = useMemo(() => {
    const all = adsQ.data ?? [];
    return all.filter(
      (a) =>
        (matchText(a.name, search) || matchText(a.metaActId, search)) &&
        (!status || a.status === status) &&
        (!currency || a.currency === currency) &&
        (!timezone || a.timezoneName === timezone) &&
        (!country || a.businessCountryCode === country),
    );
  }, [adsQ.data, country, currency, search, status, timezone]);
  const pager = usePagination(filtered);

  return (
    <div>
      <div className="text-sm text-muted-foreground mb-2">
        <Link to="/fb-accounts" className="hover:text-foreground">
          ← FB个人号
        </Link>
      </div>
      <div className="mb-4 min-w-0">
        <h1 className="truncate text-xl font-semibold">{fb?.name ?? '…'}</h1>
        <p className="text-sm text-muted-foreground">
          绑定账号 {fb?.fbUserId ?? '-'} · 状态 {accountGroupStatusLabel(fb?.status)}
        </p>
      </div>

      {adsQ.error && (
        <p className="text-sm text-destructive mb-2">{(adsQ.error as Error).message}</p>
      )}

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="font-medium">FB个人号下广告账户</h2>
        <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => adsQ.refetch()}>
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
                { value: 'active', label: adAccountStatusLabel('active') },
                { value: 'pending', label: adAccountStatusLabel('pending') },
                { value: 'disabled', label: adAccountStatusLabel('disabled') },
                { value: 'closed', label: adAccountStatusLabel('closed') },
              ],
            },
            {
              key: 'currency',
              label: '币种',
              value: currency,
              onChange: setCurrency,
              options: currencyOptions,
            },
            {
              key: 'timezone',
              label: '时区',
              value: timezone,
              onChange: setTimezone,
              options: timezoneOptions,
            },
            {
              key: 'country',
              label: '投放国家',
              value: country,
              onChange: setCountry,
              options: countryOptions,
            },
          ]}
          total={adsQ.data?.length ?? 0}
          filtered={filtered.length}
          onReset={() => {
            setSearch('');
            setStatus('');
            setCurrency('');
            setTimezone('');
            setCountry('');
          }}
        />
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Meta 账户 ID</TableHead>
              <TableHead>币种</TableHead>
              <TableHead>时区</TableHead>
              <TableHead>投放国家</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>最后同步</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adsQ.isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  该FB个人号下暂无广告账户
                </TableCell>
              </TableRow>
            )}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  无匹配项
                </TableCell>
              </TableRow>
            )}
            {pager.pageItems.map((a) => (
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
                <TableCell>{a.timezoneName ?? '-'}</TableCell>
                <TableCell>{countryLabel(a.businessCountryCode)}</TableCell>
                <TableCell
                  className={
                    a.status === 'active'
                      ? 'text-emerald-600'
                      : a.status === 'pending'
                        ? 'text-amber-600'
                        : 'text-rose-600'
                  }
                >
                  {adAccountStatusLabel(a.status)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : '-'}
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

function countryLabel(code: string | null | undefined): string {
  if (!code) return '-';
  return code.toUpperCase();
}
