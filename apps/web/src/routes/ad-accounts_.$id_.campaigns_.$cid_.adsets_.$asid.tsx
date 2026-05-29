import { createFileRoute, redirect, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getToken, type Ad, type DatePreset } from '@/lib/api';
import { EntityListView } from '@/components/EntityListView';
import { Button } from '@/components/ui/button';
import { TimezoneClock } from '@/components/TimezoneClock';

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
  const navigate = useNavigate();
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
  const adsets = useQuery({
    queryKey: ['adsets', id, cid],
    queryFn: () => api.adSets(id, cid),
  });
  const ads = useQuery({
    queryKey: ['ads', id, asid],
    queryFn: () => api.ads(id, asid),
  });
  const insights = useQuery({
    queryKey: ['insights', id, 'ad', asid, preset],
    queryFn: () => api.insightsByLevel(id, 'ad', preset, asid),
  });

  const adset = adsets.data?.find((item) => item.id === asid);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-md border bg-background p-3 xl:grid-cols-[1fr_auto]">
        <div className="grid min-w-0 gap-3 md:grid-cols-3">
          <label className="min-w-0 space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">广告账户</span>
            <div className="h-9 truncate rounded-md border bg-muted px-3 py-2 text-sm">
              {summary.data?.name ?? id}
            </div>
          </label>
          <label className="min-w-0 space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">广告系列</span>
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
          <label className="min-w-0 space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">当前广告组</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={asid}
              onChange={(event) =>
                navigate({
                  to: '/ad-accounts/$id/campaigns/$cid/adsets/$asid',
                  params: { id, cid, asid: event.currentTarget.value },
                })
              }
            >
              {(adsets.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link to="/ad-accounts/$id" params={{ id }}>
              广告系列列表
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link to="/ad-accounts/$id/campaigns/$cid" params={{ id, cid }}>
              广告组列表
            </Link>
          </Button>
        </div>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{adset?.name ?? '广告组'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            优化目标：{adset?.optimizationGoal ?? '-'}
          </p>
        </div>
        <TimezoneClock timezone={summary.data?.timezoneName ?? null} />
      </header>

      <EntityListView<Ad>
        layer="ad"
        layerLabel="广告"
        adAccountId={id}
        rows={ads.data ?? []}
        isLoading={ads.isLoading}
        error={ads.error}
        refetch={() => {
          void queryClient
            .fetchQuery({
              queryKey: ['ads', id, asid],
              queryFn: () => api.ads(id, asid, { force: true }),
            })
            .catch(() => undefined);
          void insights.refetch();
        }}
        enableBudget={false}
        currency={summary.data?.currency ?? null}
        adAccountTimezone={summary.data?.timezoneName ?? null}
        {...(insights.data ? { insights: insights.data } : {})}
        datePreset={preset}
        onDatePresetChange={setPreset}
        invalidateKey={['ads', id, asid]}
      />
    </div>
  );
}
