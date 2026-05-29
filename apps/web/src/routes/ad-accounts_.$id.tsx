import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getToken, type Campaign, type DatePreset } from '@/lib/api';
import { EntityListView } from '@/components/EntityListView';
import { Button } from '@/components/ui/button';
import { TimezoneClock } from '@/components/TimezoneClock';

export const Route = createFileRoute('/ad-accounts_/$id')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdAccountCampaignsPage,
});

function AdAccountCampaignsPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState<DatePreset>('yesterday');

  const summary = useQuery({
    queryKey: ['ad-account-summary', id],
    queryFn: () => api.adAccountSummary(id),
  });
  const campaigns = useQuery({
    queryKey: ['campaigns', id],
    queryFn: () => api.campaigns(id),
  });
  const insights = useQuery({
    queryKey: ['insights', id, 'campaign', preset],
    queryFn: () => api.insightsByLevel(id, 'campaign', preset),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background p-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">当前广告账户</div>
          <div className="mt-1 font-medium">{summary.data?.name ?? '加载中'}</div>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link to="/ad-accounts">广告账户列表</Link>
          </Button>
          {summary.data?.fbAccountId && (
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <Link to="/fb-accounts/$id" params={{ id: summary.data.fbAccountId }}>
                FB个人号
              </Link>
            </Button>
          )}
        </div>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{summary.data?.name ?? '广告账户'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.data?.metaActId ?? '-'} / 币种 {summary.data?.currency ?? '-'} / 时区{' '}
            {summary.data?.timezoneName ?? '-'} / 投放国家{' '}
            {countryLabel(summary.data?.businessCountryCode)}
          </p>
        </div>
        <TimezoneClock timezone={summary.data?.timezoneName ?? null} />
      </header>

      <EntityListView<Campaign>
        layer="campaign"
        layerLabel="广告系列"
        adAccountId={id}
        rows={campaigns.data ?? []}
        isLoading={campaigns.isLoading}
        error={campaigns.error}
        refetch={() => {
          void queryClient
            .fetchQuery({
              queryKey: ['campaigns', id],
              queryFn: () => api.campaigns(id, { force: true }),
            })
            .catch(() => undefined);
          void insights.refetch();
        }}
        drillTo={(row) => ({
          to: '/ad-accounts/$id/campaigns/$cid',
          params: { id, cid: row.id },
        })}
        enableBudget
        currency={summary.data?.currency ?? null}
        adAccountTimezone={summary.data?.timezoneName ?? null}
        {...(insights.data ? { insights: insights.data } : {})}
        datePreset={preset}
        onDatePresetChange={setPreset}
        invalidateKey={['campaigns', id]}
      />
    </div>
  );
}

function countryLabel(code: string | null | undefined): string {
  if (!code) return '-';
  return code.toUpperCase();
}
