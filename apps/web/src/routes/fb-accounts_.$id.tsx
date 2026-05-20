import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, getToken } from '@/lib/api';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/fb-accounts_/$id')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: FbAccountAdAccountsPage,
});

function FbAccountAdAccountsPage() {
  const { id } = Route.useParams();
  const fbQ = useQuery({
    queryKey: ['fb-accounts'],
    queryFn: api.fbAccounts,
  });
  const adsQ = useQuery({
    queryKey: ['ad-accounts', id],
    queryFn: () => api.adAccounts(id),
  });

  const fb = fbQ.data?.find((f) => f.id === id);

  return (
    <div>
      <div className="text-sm text-muted-foreground mb-2">
        <Link to="/fb-accounts" className="hover:text-foreground">
          ← FB 个号
        </Link>
      </div>
      <div className="mb-4">
        <h1 className="text-xl font-semibold">{fb?.name ?? '…'}</h1>
        <p className="text-sm text-muted-foreground">
          {fb?.fbUserId} · 状态 {fb?.status}
        </p>
      </div>

      {adsQ.error && (
        <p className="text-sm text-destructive mb-2">{(adsQ.error as Error).message}</p>
      )}

      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium">广告账户</h2>
        <Button size="sm" variant="outline" onClick={() => adsQ.refetch()}>
          刷新
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>Meta 账户 ID</TableHead>
              <TableHead>币种</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>最后同步</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adsQ.isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!adsQ.isLoading && adsQ.data && adsQ.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  无广告账户
                </TableCell>
              </TableRow>
            )}
            {adsQ.data?.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/ad-accounts/$id"
                    params={{ id: a.id }}
                    className="text-primary hover:underline"
                  >
                    {a.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{a.metaActId}</TableCell>
                <TableCell>{a.currency ?? '-'}</TableCell>
                <TableCell
                  className={
                    a.status === 'active'
                      ? 'text-emerald-600'
                      : a.status === 'pending'
                        ? 'text-amber-600'
                        : 'text-rose-600'
                  }
                >
                  {a.status}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {a.lastSyncedAt ? new Date(a.lastSyncedAt).toLocaleString() : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
