import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, getToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TimezoneClock } from '@/components/TimezoneClock';
import { MetaAdsManagerPanel } from '@/components/MetaAdsManagerPanel';

export const Route = createFileRoute('/ad-accounts_/$id')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AdAccountCampaignsPage,
});

function AdAccountCampaignsPage() {
  const { id } = Route.useParams();

  const summary = useQuery({
    queryKey: ['ad-account-summary', id],
    queryFn: () => api.adAccountSummary(id),
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

      <MetaAdsManagerPanel
        adAccountId={id}
        currency={summary.data?.currency ?? null}
        timezone={summary.data?.timezoneName ?? null}
      />
    </div>
  );
}

function countryLabel(code: string | null | undefined): string {
  if (!code) return '-';
  return code.toUpperCase();
}
