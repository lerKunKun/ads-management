import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, getToken, type InsightsDateSpec } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';
import { PAGE_SIZE, PAGE_SIZE_OPTIONS, Pagination, usePagination } from '@/components/Pagination';
import { SelectionClearPill } from '@/components/SelectionClearPill';
import { DateRangePicker, type DateRangePickerValue } from '@/components/DateRangePicker';
import { accountGroupStatusLabel, adAccountStatusLabel } from '@/lib/labels';
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

const ACCOUNT_TABLE_CLASS = 'min-w-[1040px] table-fixed text-sm lg:min-w-0';
const ACCOUNT_TABLE_WRAPPER_CLASS = 'max-h-[calc(100svh-300px)] overflow-x-auto overflow-y-auto overscroll-contain lg:max-h-[calc(100vh-260px)] lg:overflow-x-hidden';
const SUMMARY_CELL_CLASS = 'sticky bottom-0 z-20 bg-[#B9DEFF]';
const SELECT_COL_CLASS = 'w-11 px-2 py-2.5 text-center';
const NAME_COL_CLASS = 'w-64 px-2.5 py-2.5 lg:w-auto';
const META_COL_CLASS = 'w-36 px-2 py-2.5';
const SHORT_COL_CLASS = 'w-20 px-2 py-2.5';
const STATUS_COL_CLASS = 'w-24 px-2 py-2.5';
const SYNC_COL_CLASS = 'w-36 px-2 py-2.5';
const FB_AD_ACCOUNTS_SUMMARY_PREFIX_COLS = 5;
const FB_AD_ACCOUNTS_TOTAL_COLS = 6 + ACCOUNT_METRIC_COLUMN_COUNT;

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
  const fbNameById = useMemo(
    () => createFbAccountNameMap(fbQ.data ?? []),
    [fbQ.data],
  );
  const visibleAccounts = useMemo(
    () => filterFbNameDuplicateAdAccounts(adsQ.data ?? [], fbNameById),
    [adsQ.data, fbNameById],
  );

  const [search, setSearch] = useState('');
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

  const currencyOptions = useMemo(() => {
    const set = new Set<string>();
    visibleAccounts.forEach((a) => {
      if (a.currency) set.add(a.currency);
    });
    return [
      { value: '', label: '全部' },
      ...Array.from(set).sort().map((c) => ({ value: c, label: c })),
    ];
  }, [visibleAccounts]);

  const timezoneOptions = useMemo(() => {
    const set = new Set<string>();
    visibleAccounts.forEach((a) => {
      if (a.timezoneName) set.add(a.timezoneName);
    });
    return [
      { value: '', label: '全部' },
      ...Array.from(set).sort().map((value) => ({ value, label: value })),
    ];
  }, [visibleAccounts]);

  const countryOptions = useMemo(() => {
    const set = new Set<string>();
    visibleAccounts.forEach((a) => {
      if (a.businessCountryCode) set.add(a.businessCountryCode);
    });
    return [
      { value: '', label: '全部' },
      ...Array.from(set).sort().map((value) => ({ value, label: countryLabel(value) })),
    ];
  }, [visibleAccounts]);

  const filtered = useMemo(() => {
    return visibleAccounts.filter(
      (a) =>
        (matchText(a.name, search) || matchText(a.metaActId, search)) &&
        (!status || a.status === status) &&
        (!currency || a.currency === currency) &&
        (!timezone || a.timezoneName === timezone) &&
        (!country || a.businessCountryCode === country),
    );
  }, [country, currency, search, status, timezone, visibleAccounts]);
  const metricAccounts = filtered;
  const accountMetrics = useAdAccountInsightTotals(metricAccounts, insightsDateSpec);
  const sorted = sortAdAccountsByMetric(filtered, accountMetrics, metricSort);
  const pager = usePagination(sorted, pageSize);
  const pageIds = useMemo(() => pager.pageItems.map((account) => account.id), [pager.pageItems]);
  const pageSelected = pageIds.length > 0 && pageIds.every((accountId) => selectedIds.has(accountId));
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

  function toggleSelected(accountId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function togglePageSelected() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (pageSelected) {
        for (const accountId of pageIds) next.delete(accountId);
      } else {
        for (const accountId of pageIds) next.add(accountId);
      }
      return next;
    });
  }

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
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="font-medium">FB个人号下广告账户</h2>
          <SelectionClearPill
            count={selectedIds.size}
            itemLabel="广告账户"
            onClear={() => setSelectedIds(new Set())}
          />
        </div>
        <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <div className="grid gap-1 text-sm sm:flex sm:items-center sm:justify-end">
            <span className="whitespace-nowrap text-xs text-muted-foreground">日期范围</span>
            <DateRangePicker value={dateSelection} onChange={setDateSelection} />
          </div>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => adsQ.refetch()}>
            刷新
          </Button>
        </div>
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
              <TableHead className={SHORT_COL_CLASS}>币种</TableHead>
              <TableHead className={STATUS_COL_CLASS}>状态</TableHead>
              <AccountMetricHeaders sort={metricSort} onSort={toggleMetricSort} />
              <TableHead className={SYNC_COL_CLASS}>最后同步</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adsQ.isLoading && (
              <TableRow>
                <TableCell colSpan={FB_AD_ACCOUNTS_TOTAL_COLS} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={FB_AD_ACCOUNTS_TOTAL_COLS} className="text-muted-foreground">
                  该FB个人号下暂无广告账户
                </TableCell>
              </TableRow>
            )}
            {!adsQ.isLoading && (adsQ.data?.length ?? 0) > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={FB_AD_ACCOUNTS_TOTAL_COLS} className="text-muted-foreground">
                  无匹配项
                </TableCell>
              </TableRow>
            )}
            {pager.pageItems.map((a) => (
              <TableRow key={a.id}>
                <TableCell data-label="选择" className={SELECT_COL_CLASS}>
                  <label className="flex min-h-10 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      className="h-5 w-5 cursor-pointer accent-primary"
                      checked={selectedIds.has(a.id)}
                      onChange={() => toggleSelected(a.id)}
                      aria-label={`选择${a.name}`}
                    />
                  </label>
                </TableCell>
                <TableCell data-label="名称" className={`${NAME_COL_CLASS} font-medium`}>
                  <Link
                    to="/ad-accounts/$id"
                    params={{ id: a.id }}
                    className="block whitespace-normal break-words text-primary hover:underline"
                    title={a.name}
                  >
                    {a.name}
                  </Link>
                </TableCell>
                <TableCell data-label="Meta 账户 ID" className={`${META_COL_CLASS} break-all font-mono text-xs sm:text-sm`} title={a.metaActId}>
                  {a.metaActId}
                </TableCell>
                <TableCell data-label="币种" className={SHORT_COL_CLASS}>{a.currency ?? '-'}</TableCell>
                <TableCell
                  data-label="状态"
                  className={`${STATUS_COL_CLASS} ${
                    a.status === 'active'
                      ? 'text-emerald-600'
                      : a.status === 'pending'
                        ? 'text-amber-600'
                        : 'text-rose-600'
                  }`}
                >
                  {adAccountStatusLabel(a.status)}
                </TableCell>
                <AccountMetricCells total={accountMetrics.get(a.id)} currency={a.currency} />
                <TableCell data-label="最后同步" className={`${SYNC_COL_CLASS} whitespace-normal text-xs text-muted-foreground`}>
                  {a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter className="sticky bottom-0 z-30">
            <AdAccountSummaryRow
              prefixColSpan={FB_AD_ACCOUNTS_SUMMARY_PREFIX_COLS}
              label={`个号数据 ${summaryRows.length} 项`}
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

function countryLabel(code: string | null | undefined): string {
  if (!code) return '-';
  return code.toUpperCase();
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
