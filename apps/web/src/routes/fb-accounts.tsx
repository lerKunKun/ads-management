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

export const Route = createFileRoute('/fb-accounts')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: FbAccountsPage,
});

const STATUS_COLOR: Record<string, string> = {
  active: 'text-emerald-600',
  token_invalid: 'text-rose-600',
  disabled: 'text-rose-600',
};

function FbAccountsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['fb-accounts'],
    queryFn: api.fbAccounts,
  });

  async function bindFb() {
    try {
      const r = await api.fbAuthorizeUrl();
      window.location.href = r.authorize_url;
    } catch (e) {
      alert(`获取授权链接失败: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">FB 个号</h1>
          <p className="text-sm text-muted-foreground">
            登录后默认入口。点个号名称进入旗下广告账户。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            刷新
          </Button>
          <Button size="sm" onClick={bindFb}>
            绑定 FB 个号
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive mb-2">{(error as Error).message}</p>
      )}

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>FB 用户 ID</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>广告账户数</TableHead>
              <TableHead>Token 到期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && data && data.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  尚未绑定 FB 个号
                </TableCell>
              </TableRow>
            )}
            {data?.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/fb-accounts/$id"
                    params={{ id: f.id }}
                    className="text-primary hover:underline"
                  >
                    {f.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{f.fbUserId}</TableCell>
                <TableCell className={STATUS_COLOR[f.status] ?? ''}>{f.status}</TableCell>
                <TableCell>{f.adAccountCount}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {f.tokenExpiresAt ? new Date(f.tokenExpiresAt).toLocaleString() : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
