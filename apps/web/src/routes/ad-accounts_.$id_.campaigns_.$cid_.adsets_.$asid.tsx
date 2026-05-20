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

  const campaign = campaigns.data?.find((c) => c.id === cid);
  const adset = adsets.data?.find((s) => s.id === asid);

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        <Link to="/fb-accounts" className="hover:text-foreground">
          FB 个号
        </Link>
        {' / '}
        <Link to="/ad-accounts/$id" params={{ id }} className="hover:text-foreground">
          {summary.data?.name}
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

      <div>
        <h1 className="text-xl font-semibold">{adset?.name ?? '…'}</h1>
        <p className="text-sm text-muted-foreground">
          优化目标: {adset?.optimizationGoal ?? '-'}
        </p>
      </div>

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
