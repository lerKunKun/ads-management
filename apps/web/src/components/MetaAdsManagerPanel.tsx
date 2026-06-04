import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type Ad,
  type AdSet,
  type Campaign,
  type InsightsDateSpec,
  type InsightsSummary,
} from '@/lib/api';
import {
  EntityListView,
  summarizeInsightValues,
  type CopySelection,
} from '@/components/EntityListView';
import { DateRangePicker, type DateRangePickerValue } from '@/components/DateRangePicker';
import { SelectionClearPill } from '@/components/SelectionClearPill';

interface MetaAdsManagerPanelProps {
  adAccountId: string;
  currency: string | null;
  timezone: string | null;
}

type ActiveLayer = 'campaign' | 'adset' | 'ad';
const LAYER_DEPTH: Record<ActiveLayer, number> = { campaign: 0, adset: 1, ad: 2 };

export function MetaAdsManagerPanel({
  adAccountId,
  currency,
  timezone,
}: MetaAdsManagerPanelProps) {
  const queryClient = useQueryClient();
  const [dateSelection, setDateSelection] = useState<DateRangePickerValue>(() => {
    const today = formatDateInput(new Date());
    return { mode: 'today', since: today, until: today };
  });
  const [activeLayer, setActiveLayer] = useState<ActiveLayer>('campaign');
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignPageSize, setCampaignPageSize] = useState(100);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<Set<string>>(() => new Set());
  const [selectedAdsetIds, setSelectedAdsetIds] = useState<Set<string>>(() => new Set());
  const [selectedAdIds, setSelectedAdIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setActiveLayer('campaign');
    setCampaignPage(1);
    setCampaignSearch('');
    setSelectedCampaignIds(new Set());
    setSelectedAdsetIds(new Set());
    setSelectedAdIds(new Set());
  }, [adAccountId]);

  const campaignIds = useMemo(() => sortedIds(selectedCampaignIds), [selectedCampaignIds]);
  const adsetIds = useMemo(() => sortedIds(selectedAdsetIds), [selectedAdsetIds]);
  const campaignScopeKey = campaignIds.join('|');
  const adsetScopeKey = adsetIds.join('|');
  const insightsDateSpec = useMemo<InsightsDateSpec>(
    () =>
      dateSelection.mode === 'custom'
        ? { since: dateSelection.since, until: dateSelection.until }
        : dateSelection.mode,
    [dateSelection],
  );
  const insightsDateKey =
    typeof insightsDateSpec === 'string'
      ? insightsDateSpec
      : `${insightsDateSpec.since}_${insightsDateSpec.until}`;

  const campaigns = useQuery({
    queryKey: ['campaigns', adAccountId, campaignPage, campaignPageSize, campaignSearch],
    queryFn: () =>
      api.campaignPage(adAccountId, {
        page: campaignPage,
        pageSize: campaignPageSize,
        search: campaignSearch,
      }),
  });
  const campaignRows = campaigns.data?.rows ?? [];

  useEffect(() => {
    if (campaigns.data?.syncStatus !== 'syncing') return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns', adAccountId] });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [adAccountId, campaigns.data?.syncStatus, queryClient]);
  const campaignInsights = useQuery({
    queryKey: ['insights', adAccountId, 'campaign', insightsDateKey],
    queryFn: () => api.insightsByLevel(adAccountId, 'campaign', insightsDateSpec),
  });
  const adAccountSummary = useMemo(
    () => summarizeInsightValues(campaignInsights.data),
    [campaignInsights.data],
  );

  const adsetQueries = useQueries({
    queries: campaignIds.map((campaignId) => ({
      queryKey: ['adsets', adAccountId, campaignId],
      queryFn: () => api.adSets(adAccountId, campaignId),
    })),
  });
  const adsetInsightQueries = useQueries({
    queries: campaignIds.map((campaignId) => ({
      queryKey: ['insights', adAccountId, 'adset', campaignId, insightsDateKey],
      queryFn: () => api.insightsByLevel(adAccountId, 'adset', insightsDateSpec, campaignId),
    })),
  });
  const adsets = useMemo(
    () => uniqueById(adsetQueries.flatMap((query) => query.data ?? [])),
    [adsetQueries],
  );
  const adsetInsights = useMemo(
    () => mergeInsightRecords(adsetInsightQueries.map((query) => query.data)),
    [adsetInsightQueries],
  );

  const adQueries = useQueries({
    queries: adsetIds.map((adsetId) => ({
      queryKey: ['ads', adAccountId, adsetId],
      queryFn: () => api.ads(adAccountId, adsetId),
    })),
  });
  const adInsightQueries = useQueries({
    queries: adsetIds.map((adsetId) => ({
      queryKey: ['insights', adAccountId, 'ad', adsetId, insightsDateKey],
      queryFn: () => api.insightsByLevel(adAccountId, 'ad', insightsDateSpec, adsetId),
    })),
  });
  const ads = useMemo(
    () => uniqueById(adQueries.flatMap((query) => query.data ?? [])),
    [adQueries],
  );
  const adInsights = useMemo(
    () => mergeInsightRecords(adInsightQueries.map((query) => query.data)),
    [adInsightQueries],
  );

  function onCampaignSelectionChange(next: Set<string>) {
    setSelectedCampaignIds(next);
    setSelectedAdsetIds(new Set());
    setSelectedAdIds(new Set());
  }

  function onAdsetSelectionChange(next: Set<string>) {
    setSelectedAdsetIds(next);
    setSelectedAdIds(new Set());
  }

  function refreshCampaigns() {
    void api
      .campaignPage(adAccountId, {
        force: true,
        page: campaignPage,
        pageSize: campaignPageSize,
        search: campaignSearch,
      })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ['campaigns', adAccountId] });
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ['campaigns', adAccountId] });
        }, 3000);
      })
      .catch(() => undefined);
    void campaignInsights.refetch();
  }

  function refreshAdsets() {
    if (campaignIds.length === 0) return;
    void Promise.all(
      campaignIds.map((campaignId) =>
        queryClient.fetchQuery({
          queryKey: ['adsets', adAccountId, campaignId],
          queryFn: () => api.adSets(adAccountId, campaignId, { force: true }),
        }),
      ),
    ).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['insights', adAccountId, 'adset'] });
  }

  function refreshAds() {
    if (adsetIds.length === 0) return;
    void Promise.all(
      adsetIds.map((adsetId) =>
        queryClient.fetchQuery({
          queryKey: ['ads', adAccountId, adsetId],
          queryFn: () => api.ads(adAccountId, adsetId, { force: true }),
        }),
      ),
    ).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['insights', adAccountId, 'ad'] });
  }

  function clearCampaignSelection() {
    setSelectedCampaignIds(new Set());
    setSelectedAdsetIds(new Set());
    setSelectedAdIds(new Set());
  }

  function clearAdsetSelection() {
    setSelectedAdsetIds(new Set());
    setSelectedAdIds(new Set());
  }

  function clearAdSelection() {
    setSelectedAdIds(new Set());
  }

  function clearCurrentLayerSelectionOnly() {
    if (activeLayer === 'campaign') setSelectedCampaignIds(new Set());
    if (activeLayer === 'adset') setSelectedAdsetIds(new Set());
    if (activeLayer === 'ad') setSelectedAdIds(new Set());
  }

  function switchLayer(nextLayer: ActiveLayer) {
    if (nextLayer === activeLayer) return;
    if (LAYER_DEPTH[nextLayer] < LAYER_DEPTH[activeLayer]) {
      clearCurrentLayerSelectionOnly();
    }
    setActiveLayer(nextLayer);
  }

  function openCampaignAdsets(row: Campaign) {
    setSelectedCampaignIds(new Set([row.id]));
    setSelectedAdsetIds(new Set());
    setSelectedAdIds(new Set());
    setActiveLayer('adset');
  }

  function openAdsetAds(row: AdSet) {
    setSelectedAdsetIds(new Set([row.id]));
    setSelectedAdIds(new Set());
    setActiveLayer('ad');
  }

  function completeSelectedCampaignCopyIds(): string[] {
    if (
      selectedCampaignIds.size === 0 ||
      selectedAdsetIds.size === 0 ||
      selectedAdIds.size === 0
    ) {
      return [];
    }

    const allAdsetIds = new Set<string>();
    for (let i = 0; i < campaignIds.length; i++) {
      const rows = adsetQueries[i]?.data;
      if (!rows) return [];
      for (const row of rows) allAdsetIds.add(row.id);
    }
    if (allAdsetIds.size === 0 || !sameStringSet(selectedAdsetIds, allAdsetIds)) {
      return [];
    }

    const allAdIds = new Set<string>();
    for (let i = 0; i < adsetIds.length; i++) {
      const rows = adQueries[i]?.data;
      if (!rows) return [];
      for (const row of rows) allAdIds.add(row.id);
    }
    if (allAdIds.size === 0 || !sameStringSet(selectedAdIds, allAdIds)) {
      return [];
    }

    return campaignIds;
  }

  function resolvePanelBatchCopySelection(selection: CopySelection): CopySelection {
    if (selection.layer === 'campaign') return selection;

    const campaignCopyIds = completeSelectedCampaignCopyIds();
    if (campaignCopyIds.length === 0) return selection;

    return {
      layer: 'campaign',
      ids: campaignCopyIds,
      hint: `完整复制 ${campaignCopyIds.length} 个广告系列（包含全部广告组和广告）`,
      forceDeepCopy: true,
    };
  }

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-md border bg-background">
        <div className="grid gap-2 border-b bg-muted/50 p-2 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="grid min-w-0 gap-2 md:grid-cols-3">
            <LayerTab
              label="广告系列"
              active={activeLayer === 'campaign'}
              selectedCount={selectedCampaignIds.size}
              totalCount={campaigns.data?.total ?? 0}
              onClick={() => switchLayer('campaign')}
              onClearSelected={clearCampaignSelection}
            />
            <LayerTab
              label="广告组"
              active={activeLayer === 'adset'}
              selectedCount={selectedAdsetIds.size}
              totalCount={adsets.length}
              hint={campaignIds.length > 0 ? `${campaignIds.length} 个系列内` : '先选系列'}
              onClick={() => switchLayer('adset')}
              onClearSelected={clearAdsetSelection}
            />
            <LayerTab
              label="广告"
              active={activeLayer === 'ad'}
              selectedCount={selectedAdIds.size}
              totalCount={ads.length}
              hint={adsetIds.length > 0 ? `${adsetIds.length} 个广告组内` : '先选广告组'}
              onClick={() => switchLayer('ad')}
              onClearSelected={clearAdSelection}
            />
          </div>
          <div className="grid gap-1 text-sm sm:flex sm:items-center sm:justify-end">
            <span className="whitespace-nowrap text-xs text-muted-foreground">日期范围</span>
            <DateRangePicker value={dateSelection} onChange={setDateSelection} />
          </div>
        </div>

        <div className="p-3">
          {activeLayer === 'campaign' && (
            <EntityListView<Campaign>
              layer="campaign"
              layerLabel="广告系列"
              adAccountId={adAccountId}
              rows={campaignRows}
              isLoading={campaigns.isLoading}
              error={campaigns.error}
              refetch={refreshCampaigns}
              onRowOpen={openCampaignAdsets}
              enableBudget
              currency={currency}
              adAccountTimezone={timezone}
              insights={campaignInsights.data ?? {}}
              datePreset={dateSelection.mode === 'custom' ? 'today' : dateSelection.mode}
              onDatePresetChange={(next) => setDateSelection((current) => ({ ...current, mode: next }))}
              invalidateKey={['meta-panel-campaigns', adAccountId]}
              selectedIds={selectedCampaignIds}
              onSelectedIdsChange={onCampaignSelectionChange}
              scopeLabel="选中广告系列后切到广告组"
              showDatePreset={false}
              pagination={{
                page: campaignPage,
                pageSize: campaignPageSize,
                total: campaigns.data?.total ?? 0,
                onPageChange: setCampaignPage,
                onPageSizeChange: (next) => {
                  setCampaignPageSize(next);
                  setCampaignPage(1);
                },
              }}
              syncInfo={
                campaigns.data
                  ? {
                      status: campaigns.data.syncStatus,
                      lastSyncedAt: campaigns.data.lastSyncedAt,
                      stale: campaigns.data.stale,
                      lastError: campaigns.data.lastError,
                    }
                  : undefined
              }
              serverSearch={{
                value: campaignSearch,
                onChange: (next) => {
                  setCampaignSearch(next);
                  setCampaignPage(1);
                },
              }}
              summaryOverride={{ label: '广告账户数据', summary: adAccountSummary }}
            />
          )}

          {activeLayer === 'adset' && (
            <EntityListView<AdSet>
              layer="adset"
              layerLabel="广告组"
              adAccountId={adAccountId}
              rows={adsets}
              isLoading={campaignIds.length > 0 && adsetQueries.some((query) => query.isLoading)}
              error={firstQueryError(adsetQueries)}
              refetch={refreshAdsets}
              onRowOpen={openAdsetAds}
              enableBudget
              currency={currency}
              adAccountTimezone={timezone}
              insights={adsetInsights}
              datePreset={dateSelection.mode === 'custom' ? 'today' : dateSelection.mode}
              onDatePresetChange={(next) => setDateSelection((current) => ({ ...current, mode: next }))}
              invalidateKey={['meta-panel-adsets', adAccountId, campaignScopeKey]}
              selectedIds={selectedAdsetIds}
              onSelectedIdsChange={onAdsetSelectionChange}
              resolveBatchCopySelection={resolvePanelBatchCopySelection}
              scopeLabel={campaignIds.length > 0 ? `来自 ${campaignIds.length} 个广告系列` : '先选择广告系列'}
              emptyText={
                campaignIds.length > 0
                  ? '所选广告系列暂无广告组'
                  : '先在广告系列表勾选一个或多个广告系列'
              }
              showDatePreset={false}
              summaryOverride={{ label: '广告账户数据', summary: adAccountSummary }}
            />
          )}

          {activeLayer === 'ad' && (
            <EntityListView<Ad>
              layer="ad"
              layerLabel="广告"
              adAccountId={adAccountId}
              rows={ads}
              isLoading={adsetIds.length > 0 && adQueries.some((query) => query.isLoading)}
              error={firstQueryError(adQueries)}
              refetch={refreshAds}
              enableBudget={false}
              currency={currency}
              adAccountTimezone={timezone}
              insights={adInsights}
              datePreset={dateSelection.mode === 'custom' ? 'today' : dateSelection.mode}
              onDatePresetChange={(next) => setDateSelection((current) => ({ ...current, mode: next }))}
              invalidateKey={['meta-panel-ads', adAccountId, adsetScopeKey]}
              selectedIds={selectedAdIds}
              onSelectedIdsChange={setSelectedAdIds}
              resolveBatchCopySelection={resolvePanelBatchCopySelection}
              scopeLabel={adsetIds.length > 0 ? `来自 ${adsetIds.length} 个广告组` : '先选择广告组'}
              emptyText={
                adsetIds.length > 0
                  ? '所选广告组暂无广告'
                  : '先在广告组表勾选一个或多个广告组'
              }
              showDatePreset={false}
              summaryOverride={{ label: '广告账户数据', summary: adAccountSummary }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LayerTab({
  label,
  active,
  selectedCount,
  totalCount,
  hint,
  onClick,
  onClearSelected,
}: {
  label: string;
  active: boolean;
  selectedCount: number;
  totalCount: number;
  hint?: string;
  onClick: () => void;
  onClearSelected: () => void;
}) {
  return (
    <div
      className={[
        'flex min-h-11 min-w-0 items-center gap-2 rounded-md border px-3 transition-colors',
        active
          ? 'border-primary bg-background shadow-sm'
          : 'border-transparent bg-background/60 hover:border-input hover:bg-background',
      ].join(' ')}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center py-2 text-left"
        onClick={onClick}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">{label}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {hint ?? `共 ${totalCount} 项`}
          </span>
        </span>
      </button>
      <SelectionClearPill
        count={selectedCount}
        itemLabel={label}
        prefix="选中"
        onClear={onClearSelected}
        className="h-7 border-primary bg-primary text-primary-foreground hover:bg-primary/90"
      />
    </div>
  );
}

function sortedIds(ids: Set<string>): string[] {
  return Array.from(ids).sort();
}

function formatDateInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function mergeInsightRecords(
  records: Array<Record<string, InsightsSummary> | undefined>,
): Record<string, InsightsSummary> {
  const merged: Record<string, InsightsSummary> = {};
  for (const record of records) {
    if (!record) continue;
    Object.assign(merged, record);
  }
  return merged;
}

function firstQueryError(queries: Array<{ error: unknown }>): unknown | undefined {
  return queries.find((query) => query.error)?.error;
}
