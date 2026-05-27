import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, getToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination, usePagination } from '@/components/Pagination';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';
import { adAccountStatusLabel } from '@/lib/labels';

export const Route = createFileRoute('/ad-accounts')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdAccountsPage,
});

function AdAccountsPage() {
  const adsQ = useQuery({
    queryKey: ['ad-accounts'],
    queryFn: () => api.adAccounts(),
  });
  const fbQ = useQuery({
    queryKey: ['fb-accounts'],
    queryFn: api.fbAccounts,
  });

  const [search, setSearch] = useState('');
  const [fbAccountId, setFbAccountId] = useState('');
  const [status, setStatus] = useState('');
  const [currency, setCurrency] = useState('');
  const [timezone, setTimezone] = useState('');
  const [country, setCountry] = useState('');

  const fbById = useMemo(
    () => new Map((fbQ.data ?? []).map((account) => [account.id, account])),
    [fbQ.data],
  );

  const fbOptions = useMemo(
    () => [
      { value: '', label: '全部' },
      ...(fbQ.data ?? []).map((account) => ({ value: account.id, label: account.name })),
    ],
    [fbQ.data],
  );

  const currencyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const account of adsQ.data ?? []) {
      if (account.currency) set.add(account.currency);
    }
    return [
      { value: '', label: '全部' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: value })),
    ];
  }, [adsQ.data]);

  const timezoneOptions = useMemo(() => {
    const set = new Set<string>();
    for (const account of adsQ.data ?? []) {
      if (account.timezoneName) set.add(account.timezoneName);
    }
    return [
      { value: '', label: '全部' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: value })),
    ];
  }, [adsQ.data]);

  const countryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const account of adsQ.data ?? []) {
      if (account.businessCountryCode) set.add(account.businessCountryCode);
    }
    return [
      { value: '', label: '全部' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: countryLabel(value) })),
    ];
  }, [adsQ.data]);

  const filtered = useMemo(() => {
    const accounts = adsQ.data ?? [];
    return accounts.filter(
      (account) =>
        (matchText(account.name, search) || matchText(account.metaActId, search)) &&
        (!fbAccountId || account.fbAccountId === fbAccountId) &&
        (!status || account.status === status) &&
        (!currency || account.currency === currency) &&
        (!timezone || account.timezoneName === timezone) &&
        (!country || account.businessCountryCode === country),
    );
  }, [adsQ.data, country, currency, fbAccountId, search, status, timezone]);
  const pager = usePagination(filtered);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">广告账户</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            点击广告账户名称进入广告系列，再逐级进入广告组和广告。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          onClick={() => {
            adsQ.refetch();
            fbQ.refetch();
          }}
        >
          刷新
        </Button>
      </header>

      {(adsQ.error || fbQ.error) && (
        <p className="text-sm text-destructive">
          {(adsQ.error as Error)?.message || (fbQ.error as Error)?.message}
        </p>
      )}

      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索名称 / Meta 账户 ID..."
        filters={[
          {
            key: 'fbAccountId',
            label: '广告账户组',
            value: fbAccountId,
            onChange: setFbAccountId,
            options: fbOptions,
          },
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
          setFbAccountId('');
          setStatus('');
          setCurrency('');
          setTimezone('');
          setCountry('');
        }}
      />

      <div className="overflow-hidden rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Meta 账户 ID</TableHead>
              <TableHead>广告账户组</TableHead>
              <TableHead>币种</TableHead>
              <TableHead>时区</TableHead>
              <TableHead>投放国家</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>最后同步</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adsQ.isLoading && <EmptyRow text="加载中..." />}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) === 0 && (
              <EmptyRow text="当前没有可见广告账户，请联系管理员分配广告账户。" />
            )}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) > 0 && filtered.length === 0 && (
              <EmptyRow text="无匹配项" />
            )}
            {pager.pageItems.map((account) => {
              const fb = fbById.get(account.fbAccountId);
              return (
                <TableRow key={account.id}>
                  <TableCell className="font-medium">
                    <Link
                      to="/ad-accounts/$id"
                      params={{ id: account.id }}
                      className="text-primary hover:underline"
                    >
                      {account.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{account.metaActId}</TableCell>
                  <TableCell>
                    {fb ? (
                      <Link
                        to="/fb-accounts/$id"
                        params={{ id: fb.id }}
                        className="text-primary hover:underline"
                      >
                        {fb.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>{account.currency ?? '-'}</TableCell>
                  <TableCell>{account.timezoneName ?? '-'}</TableCell>
                  <TableCell>{countryLabel(account.businessCountryCode)}</TableCell>
                  <TableCell className={statusClass(account.status)}>
                    {adAccountStatusLabel(account.status)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString() : '-'}
                  </TableCell>
                </TableRow>
              );
            })}
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

function EmptyRow({ text }: { text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={8} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}

function statusClass(status: string): string {
  if (status === 'active') return 'text-emerald-600';
  if (status === 'pending') return 'text-amber-600';
  return 'text-rose-600';
}

function countryLabel(code: string | null | undefined): string {
  if (!code) return '-';
  return code.toUpperCase();
}
