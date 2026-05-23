import { createFileRoute, redirect, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getToken, type AdSet, type DatePreset } from '@/lib/api';
import { EntityListView } from '@/components/EntityListView';
import { Button } from '@/components/ui/button';
import { TimezoneClock } from '@/components/TimezoneClock';

export const Route = createFileRoute('/ad-accounts_/$id_/campaigns_/$cid')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdSetsPage,
});

function AdSetsPage() {
  const { id, cid } = Route.useParams();
  const navigate = useNavigate();
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
      <div className="grid gap-3 rounded-md border bg-background p-3 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">广告账户</span>
            <div className="h-9 truncate rounded-md border bg-muted px-3 py-2 text-sm">
              {summary.data?.name ?? id}
            </div>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">当前广告系列</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={cid}
              onChange={(event) =>
                navigate({
                  to: '/ad-accounts/$id/campaigns/$cid',
                  params: { id, cid: event.currentTarget.value },
                })
              }
            >
              {(campaigns.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/ad-accounts">广告账户列表</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/ad-accounts/$id" params={{ id }}>
              广告系列列表
            </Link>
          </Button>
        </div>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{campaign?.name ?? '广告系列'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            目标：{campaign?.objective ?? '-'}
          </p>
        </div>
        <TimezoneClock timezone={summary.data?.timezoneName ?? null} />
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
        adAccountTimezone={summary.data?.timezoneName ?? null}
        {...(insights.data ? { insights: insights.data } : {})}
        datePreset={preset}
        onDatePresetChange={setPreset}
        invalidateKey={['adsets', id, cid]}
      />
    </div>
  );
}
