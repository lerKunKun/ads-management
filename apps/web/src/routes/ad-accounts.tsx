import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, getToken, type InsightsDateSpec } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PAGE_SIZE, PAGE_SIZE_OPTIONS, Pagination, usePagination } from '@/components/Pagination';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';
import { SelectionClearPill } from '@/components/SelectionClearPill';
import { DateRangePicker, type DateRangePickerValue } from '@/components/DateRangePicker';
import { adAccountStatusLabel } from '@/lib/labels';
import {
  createFbAccountNameMap,
  filterFbNameDuplicateAdAccounts,
} from '@/lib/ad-account-display';
import {
  ACCOUNT_METRIC_COLUMN_COUNT,
  AccountMetricCells,
  AccountMetricHeaders,
  nextAccountMetricSort,
  sortAdAccountsByMetric,
  summarizeAdAccountMetricTotals,
  useAdAccountInsightTotals,
  type AccountMetric,
  type AccountMetricSortState,
} from '@/components/AdAccountMetricColumns';

const ACCOUNT_TABLE_CLASS = 'min-w-[1160px] table-fixed text-sm lg:min-w-0';
const ACCOUNT_TABLE_WRAPPER_CLASS = 'max-h-[calc(100svh-300px)] overflow-x-auto overflow-y-auto overscroll-contain lg:max-h-[calc(100vh-260px)] lg:overflow-x-hidden';
const SUMMARY_CELL_CLASS = 'sticky bottom-0 z-20 bg-[#B9DEFF]';
const SELECT_COL_CLASS = 'w-11 px-2 py-2.5 text-center';
const NAME_COL_CLASS = 'w-64 px-2.5 py-2.5 lg:w-auto';
const META_COL_CLASS = 'w-36 px-2 py-2.5';
const FB_COL_CLASS = 'w-40 px-2 py-2.5';
const SHORT_COL_CLASS = 'w-20 px-2 py-2.5';
const STATUS_COL_CLASS = 'w-24 px-2 py-2.5';
const SYNC_COL_CLASS = 'w-36 px-2 py-2.5';
const AD_ACCOUNTS_SUMMARY_PREFIX_COLS = 6;
const AD_ACCOUNTS_TOTAL_COLS = 7 + ACCOUNT_METRIC_COLUMN_COUNT;

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
  const [metricSort, setMetricSort] = useState<AccountMetricSortState | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [dateSelection, setDateSelection] = useState<DateRangePickerValue>(initialDateSelection);
  const insightsDateSpec = useMemo<InsightsDateSpec>(
    () => toInsightsDateSpec(dateSelection),
    [dateSelection],
  );

  const fbById = useMemo(
    () => new Map((fbQ.data ?? []).map((account) => [account.id, account])),
    [fbQ.data],
  );
  const fbNameById = useMemo(
    () => createFbAccountNameMap(fbQ.data ?? []),
    [fbQ.data],
  );
  const visibleAccounts = useMemo(
    () => filterFbNameDuplicateAdAccounts(adsQ.data ?? [], fbNameById),
    [adsQ.data, fbNameById],
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
    for (const account of visibleAccounts) {
      if (account.currency) set.add(account.currency);
    }
    return [
      { value: '', label: '全部' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: value })),
    ];
  }, [visibleAccounts]);

  const timezoneOptions = useMemo(() => {
    const set = new Set<string>();
    for (const account of visibleAccounts) {
      if (account.timezoneName) set.add(account.timezoneName);
    }
    return [
      { value: '', label: '全部' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: value })),
    ];
  }, [visibleAccounts]);

  const countryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const account of visibleAccounts) {
      if (account.businessCountryCode) set.add(account.businessCountryCode);
    }
    return [
      { value: '', label: '全部' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: countryLabel(value) })),
    ];
  }, [visibleAccounts]);

  const filtered = useMemo(() => {
    return visibleAccounts.filter(
      (account) =>
        (matchText(account.name, search) || matchText(account.metaActId, search)) &&
        (!fbAccountId || account.fbAccountId === fbAccountId) &&
        (!status || account.status === status) &&
        (!currency || account.currency === currency) &&
        (!timezone || account.timezoneName === timezone) &&
        (!country || account.businessCountryCode === country),
    );
  }, [country, currency, fbAccountId, search, status, timezone, visibleAccounts]);
  const metricAccounts = filtered;
  const accountMetrics = useAdAccountInsightTotals(metricAccounts, insightsDateSpec);
  const sorted = sortAdAccountsByMetric(filtered, accountMetrics, metricSort);
  const pager = usePagination(sorted, pageSize);
  const pageIds = useMemo(() => pager.pageItems.map((account) => account.id), [pager.pageItems]);
  const pageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const summaryRows = filtered;
  const summary = summarizeAdAccountMetricTotals(summaryRows, accountMetrics);
  const summaryCurrency = commonCurrency(summaryRows);

  function toggleMetricSort(metric: AccountMetric) {
    setMetricSort((current) => nextAccountMetricSort(current, metric));
    pager.setPage(1);
  }

  function changePageSize(nextPageSize: number) {
    setPageSize(nextPageSize);
    pager.setPage(1);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePageSelected() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (pageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">广告账户</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            点击广告账户名称进入广告系列，再逐级进入广告组和广告。
          </p>
        </div>
        <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <SelectionClearPill
            count={selectedIds.size}
            itemLabel="广告账户"
            onClear={() => setSelectedIds(new Set())}
          />
          <div className="grid gap-1 text-sm sm:flex sm:items-center sm:justify-end">
            <span className="whitespace-nowrap text-xs text-muted-foreground">日期范围</span>
            <DateRangePicker value={dateSelection} onChange={setDateSelection} />
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
        </div>
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
            label: 'FB个人号',
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
        <Table className={ACCOUNT_TABLE_CLASS} wrapperClassName={ACCOUNT_TABLE_WRAPPER_CLASS}>
          <TableHeader className="sticky top-0 z-40 bg-background">
            <TableRow>
              <TableHead className={SELECT_COL_CLASS}>
                <label className="flex min-h-10 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    className="h-5 w-5 cursor-pointer accent-primary"
                    checked={pageSelected}
                    onChange={togglePageSelected}
                    aria-label="选择本页广告账户"
                  />
                </label>
              </TableHead>
              <TableHead className={NAME_COL_CLASS}>名称</TableHead>
              <TableHead className={META_COL_CLASS}>Meta 账户 ID</TableHead>
              <TableHead className={FB_COL_CLASS}>FB个人号</TableHead>
              <TableHead className={SHORT_COL_CLASS}>币种</TableHead>
              <TableHead className={STATUS_COL_CLASS}>状态</TableHead>
              <AccountMetricHeaders sort={metricSort} onSort={toggleMetricSort} />
              <TableHead className={SYNC_COL_CLASS}>最后同步</TableHead>
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
                  <TableCell data-label="选择" className={SELECT_COL_CLASS}>
                    <label className="flex min-h-10 cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        className="h-5 w-5 cursor-pointer accent-primary"
                        checked={selectedIds.has(account.id)}
                        onChange={() => toggleSelected(account.id)}
                        aria-label={`选择${account.name}`}
                      />
                    </label>
                  </TableCell>
                  <TableCell data-label="名称" className={`${NAME_COL_CLASS} font-medium`}>
                    <Link
                      to="/ad-accounts/$id"
                      params={{ id: account.id }}
                      className="block whitespace-normal break-words text-primary hover:underline"
                      title={account.name}
                    >
                      {account.name}
                    </Link>
                  </TableCell>
                  <TableCell data-label="Meta 账户 ID" className={`${META_COL_CLASS} break-all font-mono text-xs sm:text-sm`} title={account.metaActId}>
                    {account.metaActId}
                  </TableCell>
                  <TableCell data-label="FB个人号" className={FB_COL_CLASS}>
                    {fb ? (
                      <Link
                        to="/fb-accounts/$id"
                        params={{ id: fb.id }}
                        className="block whitespace-normal break-words text-primary hover:underline"
                        title={fb.name}
                      >
                        {fb.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell data-label="币种" className={SHORT_COL_CLASS}>{account.currency ?? '-'}</TableCell>
                  <TableCell data-label="状态" className={`${STATUS_COL_CLASS} ${statusClass(account.status)}`}>
                    {adAccountStatusLabel(account.status)}
                  </TableCell>
                  <AccountMetricCells total={accountMetrics.get(account.id)} currency={account.currency} />
                  <TableCell data-label="最后同步" className={`${SYNC_COL_CLASS} whitespace-normal text-xs text-muted-foreground`}>
                    {account.lastSyncedAt ? new Date(account.lastSyncedAt).toLocaleString() : '-'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter className="sticky bottom-0 z-30">
            <AdAccountSummaryRow
              prefixColSpan={AD_ACCOUNTS_SUMMARY_PREFIX_COLS}
              label={`当前范围 ${summaryRows.length} 项`}
              total={summary}
              currency={summaryCurrency}
            />
          </TableFooter>
        </Table>
        <Pagination
          page={pager.page}
          pageCount={pager.pageCount}
          total={sorted.length}
          pageSize={pager.pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageChange={pager.setPage}
          onPageSizeChange={changePageSize}
        />
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={AD_ACCOUNTS_TOTAL_COLS} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}

function initialDateSelection(): DateRangePickerValue {
  const today = formatDateInput(new Date());
  return { mode: 'today', since: today, until: today };
}

function toInsightsDateSpec(value: DateRangePickerValue): InsightsDateSpec {
  return value.mode === 'custom' ? { since: value.since, until: value.until } : value.mode;
}

function formatDateInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function AdAccountSummaryRow({
  prefixColSpan,
  label,
  total,
  currency,
}: {
  prefixColSpan: number;
  label: string;
  total: ReturnType<typeof summarizeAdAccountMetricTotals>;
  currency: string | null;
}) {
  return (
    <TableRow className="border-t bg-[#B9DEFF] hover:bg-[#B9DEFF]">
      <TableCell colSpan={prefixColSpan} className={`${SUMMARY_CELL_CLASS} px-2 py-2 font-semibold`}>
        汇总（{label}）
      </TableCell>
      <AccountMetricCells total={total} currency={currency} cellClassName={SUMMARY_CELL_CLASS} />
      <TableCell className={`${SUMMARY_CELL_CLASS} ${SYNC_COL_CLASS}`} />
    </TableRow>
  );
}

function commonCurrency(accounts: Array<{ currency?: string | null }>): string | null {
  const currencies = new Set(accounts.map((account) => account.currency).filter(Boolean));
  return currencies.size === 1 ? Array.from(currencies)[0]! : null;
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
