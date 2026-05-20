import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getToken, type Campaign, type DatePreset } from '@/lib/api';
import { EntityListView } from '@/components/EntityListView';

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
        <span className="text-foreground">{summary.data?.name ?? '…'}</span>
      </div>

      <div>
        <h1 className="text-xl font-semibold">{summary.data?.name ?? '…'}</h1>
        <p className="text-sm text-muted-foreground">
          {summary.data?.metaActId} · {summary.data?.currency ?? '-'}
        </p>
      </div>

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
        drillTo={(r) => ({
          to: '/ad-accounts/$id/campaigns/$cid',
          params: { id, cid: r.id },
        })}
        enableBudget
        currency={summary.data?.currency ?? null}
        {...(insights.data ? { insights: insights.data } : {})}
        datePreset={preset}
        onDatePresetChange={setPreset}
        invalidateKey={['campaigns', id]}
      />
    </div>
  );
}
