import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
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
  const [preset, setPreset] = useState<DatePreset>('last_7d');

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
        <div>
          <div className="text-xs text-muted-foreground">当前广告账户</div>
          <div className="mt-1 font-medium">{summary.data?.name ?? '加载中'}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/ad-accounts">广告账户列表</Link>
          </Button>
          {summary.data?.fbAccountId && (
            <Button asChild size="sm" variant="outline">
              <Link to="/fb-accounts/$id" params={{ id: summary.data.fbAccountId }}>
                广告账户组
              </Link>
            </Button>
          )}
        </div>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{summary.data?.name ?? '广告账户'}</h1>
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
          campaigns.refetch();
          insights.refetch();
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
