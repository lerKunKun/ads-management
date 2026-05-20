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

  const campaign = campaigns.data?.find((c) => c.id === cid);

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        <Link to="/fb-accounts" className="hover:text-foreground">
          FB 个号
        </Link>
        {summary.data?.fbAccountId && (
          <>
            {' / '}
            <Link
              to="/fb-accounts/$id"
              params={{ id: summary.data.fbAccountId }}
              className="hover:text-foreground"
            >
              {summary.data.fbAccountName}
            </Link>
          </>
        )}
        {' / '}
        <Link
          to="/ad-accounts/$id"
          params={{ id }}
          className="hover:text-foreground"
        >
          {summary.data?.name}
        </Link>
        {' / '}
        <span className="text-foreground">{campaign?.name ?? cid}</span>
      </div>

      <div>
        <h1 className="text-xl font-semibold">{campaign?.name ?? '…'}</h1>
        <p className="text-sm text-muted-foreground">
          目标: {campaign?.objective ?? '-'}
        </p>
      </div>

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
        drillTo={(r) => ({
          to: '/ad-accounts/$id/campaigns/$cid/adsets/$asid',
          params: { id, cid, asid: r.id },
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
