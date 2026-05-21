import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getToken, type Ad, type DatePreset } from '@/lib/api';
import { EntityListView } from '@/components/EntityListView';

export const Route = createFileRoute(
  '/ad-accounts_/$id_/campaigns_/$cid_/adsets_/$asid',
)({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdsPage,
});

function AdsPage() {
  const { id, cid, asid } = Route.useParams();
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
  const ads = useQuery({
    queryKey: ['ads', id, asid],
    queryFn: () => api.ads(id, asid),
  });
  const insights = useQuery({
    queryKey: ['insights', id, 'ad', preset],
    queryFn: () => api.insightsByLevel(id, 'ad', preset),
  });

  const campaign = campaigns.data?.find((item) => item.id === cid);
  const adset = adsets.data?.find((item) => item.id === asid);

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
        <Link
          to="/ad-accounts/$id/campaigns/$cid"
          params={{ id, cid }}
          className="hover:text-foreground"
        >
          {campaign?.name ?? cid}
        </Link>
        {' / '}
        <span className="text-foreground">{adset?.name ?? asid}</span>
      </div>

      <header>
        <h1 className="text-xl font-semibold">{adset?.name ?? '广告组'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          优化目标：{adset?.optimizationGoal ?? '-'}
        </p>
      </header>

      <EntityListView<Ad>
        layer="ad"
        layerLabel="广告"
        adAccountId={id}
        rows={ads.data ?? []}
        isLoading={ads.isLoading}
        error={ads.error}
        refetch={() => {
          ads.refetch();
          insights.refetch();
        }}
        enableBudget={false}
        currency={summary.data?.currency ?? null}
        {...(insights.data ? { insights: insights.data } : {})}
        datePreset={preset}
        onDatePresetChange={setPreset}
        invalidateKey={['ads', id, asid]}
      />
    </div>
  );
}
