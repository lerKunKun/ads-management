import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getToken, type AdSet, type DatePreset } from '@/lib/api';
import { EntityListView } from '@/components/EntityListView';

export const Route = createFileRoute('/ad-accounts_/$id_/campaigns_/$cid')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdSetsPage,
});

function AdSetsPage() {
  const { id, cid } = Route.useParams();
  const [preset, setPreset] = useState<DatePreset>('last_7d');

  const summary = useQuery({
    queryKey: ['ad-account-summary', id],
    queryFn: () => api.adAccountSummary(id),
  });
  const campaigns = useQuery({
    queryKey: ['campaigns', id],
    queryFn: () => api.campaigns(id),
  });
  const adsets = useQuery({
    queryKey: ['adsets', id, cid],
    queryFn: () => api.adSets(id, cid),
  });
  const insights = useQuery({
    queryKey: ['insights', id, 'adset', preset],
    queryFn: () => api.insightsByLevel(id, 'adset', preset),
  });

  const campaign = campaigns.data?.find((item) => item.id === cid);

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        <Link to="/ad-accounts" className="hover:text-foreground">
          广告账户
        </Link>
        {' / '}
        <Link to="/ad-accounts/$id" params={{ id }} className="hover:text-foreground">
          {summary.data?.name ?? id}
        </Link>
        {' / '}
        <span className="text-foreground">{campaign?.name ?? cid}</span>
      </div>

      <header>
        <h1 className="text-xl font-semibold">{campaign?.name ?? '广告系列'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          目标：{campaign?.objective ?? '-'}
        </p>
      </header>

      <EntityListView<AdSet>
        layer="adset"
        layerLabel="广告组"
        adAccountId={id}
        rows={adsets.data ?? []}
        isLoading={adsets.isLoading}
        error={adsets.error}
        refetch={() => {
          adsets.refetch();
          insights.refetch();
        }}
        drillTo={(row) => ({
          to: '/ad-accounts/$id/campaigns/$cid/adsets/$asid',
          params: { id, cid, asid: row.id },
        })}
        enableBudget
        currency={summary.data?.currency ?? null}
        {...(insights.data ? { insights: insights.data } : {})}
        datePreset={preset}
        onDatePresetChange={setPreset}
        invalidateKey={['adsets', id, cid]}
      />
    </div>
  );
}
