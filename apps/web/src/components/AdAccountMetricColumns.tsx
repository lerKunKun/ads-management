import { useQueries } from '@tanstack/react-query';
import { api, type InsightsDateSpec, type InsightsSummary } from '@/lib/api';
import { TableCell, TableHead } from '@/components/ui/table';

export type AccountMetric = 'spend' | 'orders' | 'cpa' | 'cpc' | 'addToCart' | 'initiateCheckout' | 'cpm' | 'roi';
export type AccountMetricSortState = { metric: AccountMetric; direction: 'asc' | 'desc' };

export interface AccountMetricTotal {
  hasInsights: boolean;
  spend: number;
  impressions: number;
  clicks: number;
  orders: number;
  cpa: number;
  cpc: number;
  addToCart: number;
  initiateCheckout: number;
  cpm: number;
  roi: number;
  roiCount: number;
}

export const ACCOUNT_METRIC_COLUMN_COUNT = 8;

const ACCOUNT_METRIC_COLUMNS: Array<{ metric: AccountMetric; label: string }> = [
  { metric: 'spend', label: '花费' },
  { metric: 'orders', label: '订单' },
  { metric: 'cpa', label: 'CPA' },
  { metric: 'cpc', label: 'CPC' },
  { metric: 'addToCart', label: '加购' },
  { metric: 'initiateCheckout', label: '结账' },
  { metric: 'cpm', label: 'CPM' },
  { metric: 'roi', label: 'ROI' },
];
const ACCOUNT_METRIC_CELL_BASE = 'overflow-hidden px-2 py-2.5 text-right tabular-nums';

export function useAdAccountInsightTotals(
  accounts: Array<{ id: string }>,
  dateSpec: InsightsDateSpec,
): Map<string, AccountMetricTotal> {
  const dateKey = insightsDateKey(dateSpec);
  const queries = useQueries({
    queries: accounts.map((account) => ({
      queryKey: ['ad-account-total-insights', account.id, dateKey],
      queryFn: () => api.insightsByLevel(account.id, 'campaign', dateSpec),
      staleTime: 5 * 60 * 1000,
      retry: 1,
    })),
  });

  const totals = new Map<string, AccountMetricTotal>();
  accounts.forEach((account, index) => {
    const data = queries[index]?.data;
    if (data) totals.set(account.id, summarizeAccountInsights(data));
  });
  return totals;
}

function insightsDateKey(dateSpec: InsightsDateSpec): string {
  return typeof dateSpec === 'string'
    ? dateSpec
    : `${dateSpec.since}_${dateSpec.until}`;
}

export function nextAccountMetricSort(
  current: AccountMetricSortState | null,
  metric: AccountMetric,
): AccountMetricSortState {
  if (current?.metric !== metric) return { metric, direction: 'desc' };
  return { metric, direction: current.direction === 'desc' ? 'asc' : 'desc' };
}

export function sortAdAccountsByMetric<T extends { id: string }>(
  rows: T[],
  totals: Map<string, AccountMetricTotal>,
  sort: AccountMetricSortState | null,
): T[] {
  if (!sort) return rows;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = totals.get(a.row.id);
      const right = totals.get(b.row.id);
      if (!left?.hasInsights && !right?.hasInsights) return a.index - b.index;
      if (!left?.hasInsights) return 1;
      if (!right?.hasInsights) return -1;
      const diff = metricValue(left, sort.metric) - metricValue(right, sort.metric);
      if (diff !== 0) return sort.direction === 'asc' ? diff : -diff;
      return a.index - b.index;
    })
    .map((item) => item.row);
}

export function summarizeAdAccountMetricTotals<T extends { id: string }>(
  rows: T[],
  totals: Map<string, AccountMetricTotal>,
): AccountMetricTotal {
  const total = emptyAccountMetricTotal();

  for (const row of rows) {
    const item = totals.get(row.id);
    if (!item?.hasInsights) continue;
    total.hasInsights = true;
    total.spend += item.spend;
    total.impressions += item.impressions;
    total.clicks += item.clicks;
    total.orders += item.orders;
    total.addToCart += item.addToCart;
    total.initiateCheckout += item.initiateCheckout;
    if (item.spend > 0) {
      total.roi += Math.max(item.roi, 0) * item.spend;
      total.roiCount += item.spend;
    }
  }

  total.cpa = total.orders > 0 ? total.spend / total.orders : 0;
  total.cpc = total.clicks > 0 ? total.spend / total.clicks : 0;
  total.cpm = total.impressions > 0 ? (total.spend / total.impressions) * 1000 : 0;
  total.roi = total.roiCount > 0 ? total.roi / total.roiCount : 0;
  return total;
}

export function AccountMetricHeaders({
  sort,
  onSort,
}: {
  sort: AccountMetricSortState | null;
  onSort: (metric: AccountMetric) => void;
}) {
  return (
    <>
      {ACCOUNT_METRIC_COLUMNS.map((column) => {
        const active = sort?.metric === column.metric;
        return (
          <TableHead key={column.metric} className={`${accountMetricCellClass(column.metric)} whitespace-nowrap`}>
            <button
              type="button"
              className="inline-flex min-w-0 items-center justify-end gap-1 whitespace-nowrap text-right hover:text-primary"
              onClick={() => onSort(column.metric)}
            >
              <span>{column.label}</span>
              <span className="w-3 text-xs text-muted-foreground">
                {active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
              </span>
            </button>
          </TableHead>
        );
      })}
    </>
  );
}

export function AccountMetricCells({
  total,
  currency,
  cellClassName = '',
}: {
  total: AccountMetricTotal | undefined;
  currency: string | null;
  cellClassName?: string;
}) {
  const has = total?.hasInsights === true;
  return (
    <>
      <TableCell data-label={accountMetricLabel('spend')} className={`${cellClassName} ${accountMetricCellClass('spend')}`}>
        {fmtMoney(total?.spend ?? 0, currency, has)}
      </TableCell>
      <TableCell data-label={accountMetricLabel('orders')} className={`${cellClassName} ${accountMetricCellClass('orders')}`}>
        {fmtNumber(total?.orders ?? 0, has)}
      </TableCell>
      <TableCell data-label={accountMetricLabel('cpa')} className={`${cellClassName} ${accountMetricCellClass('cpa')}`}>
        {fmtMoney(total?.cpa ?? 0, currency, has && (total?.orders ?? 0) > 0)}
      </TableCell>
      <TableCell data-label={accountMetricLabel('cpc')} className={`${cellClassName} ${accountMetricCellClass('cpc')}`}>
        {fmtDecimal(total?.cpc ?? 0, has && (total?.clicks ?? 0) > 0)}
      </TableCell>
      <TableCell data-label={accountMetricLabel('addToCart')} className={`${cellClassName} ${accountMetricCellClass('addToCart')}`}>
        {fmtNumber(total?.addToCart ?? 0, has)}
      </TableCell>
      <TableCell data-label={accountMetricLabel('initiateCheckout')} className={`${cellClassName} ${accountMetricCellClass('initiateCheckout')}`}>
        {fmtNumber(total?.initiateCheckout ?? 0, has)}
      </TableCell>
      <TableCell data-label={accountMetricLabel('cpm')} className={`${cellClassName} ${accountMetricCellClass('cpm')}`}>
        {fmtDecimal(total?.cpm ?? 0, has && (total?.impressions ?? 0) > 0)}
      </TableCell>
      <TableCell data-label={accountMetricLabel('roi')} className={`${cellClassName} ${accountMetricCellClass('roi')}`}>
        {fmtDecimal(total?.roi ?? 0, has && (total?.roiCount ?? 0) > 0)}
      </TableCell>
    </>
  );
}

function summarizeAccountInsights(rows: Record<string, InsightsSummary>): AccountMetricTotal {
  const total = emptyAccountMetricTotal();

  for (const row of Object.values(rows)) {
    total.hasInsights = true;
    total.spend += row.spend;
    total.impressions += row.impressions;
    total.clicks += row.clicks;
    total.orders += row.orders;
    total.addToCart += row.addToCart;
    total.initiateCheckout += row.initiateCheckout;
    if (row.spend > 0) {
      total.roi += Math.max(row.roi, 0) * row.spend;
      total.roiCount += row.spend;
    }
  }
  total.cpa = total.orders > 0 ? total.spend / total.orders : 0;
  total.cpc = total.clicks > 0 ? total.spend / total.clicks : 0;
  total.cpm = total.impressions > 0 ? (total.spend / total.impressions) * 1000 : 0;
  total.roi = total.roiCount > 0 ? total.roi / total.roiCount : 0;
  return total;
}

function emptyAccountMetricTotal(): AccountMetricTotal {
  return {
    hasInsights: false,
    spend: 0,
    impressions: 0,
    clicks: 0,
    orders: 0,
    cpa: 0,
    cpc: 0,
    addToCart: 0,
    initiateCheckout: 0,
    cpm: 0,
    roi: 0,
    roiCount: 0,
  };
}

function metricValue(total: AccountMetricTotal, metric: AccountMetric): number {
  return total[metric];
}

function accountMetricCellClass(metric: AccountMetric): string {
  const width =
    metric === 'spend' || metric === 'cpa'
      ? 'w-24'
      : metric === 'cpc' || metric === 'cpm'
        ? 'w-20'
        : 'w-16';
  return `${width} ${ACCOUNT_METRIC_CELL_BASE}`;
}

function accountMetricLabel(metric: AccountMetric): string {
  return ACCOUNT_METRIC_COLUMNS.find((column) => column.metric === metric)?.label ?? metric;
}

function fmtMoney(value: number, currency: string | null, show: boolean): string {
  if (!show) return '-';
  return `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

function fmtNumber(value: number, show: boolean): string {
  if (!show) return '-';
  return String(Math.round(value));
}

function fmtDecimal(value: number, show: boolean): string {
  if (!show) return '-';
  return value.toFixed(2);
}
