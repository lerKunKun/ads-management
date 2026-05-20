import { Outlet, createRootRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, clearToken, getToken } from '@/lib/api';
import { Button } from '@/components/ui/button';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const hasToken = !!getToken();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: hasToken,
    retry: false,
  });

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="container mx-auto h-14 flex items-center justify-between px-4">
          <Link to="/" className="font-semibold">
            FB 广告管理
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            {hasToken && me.data && (
              <>
                <Link to="/fb-accounts" className="text-muted-foreground hover:text-foreground">
                  FB 个号
                </Link>
                {me.data.permissions.includes('iam:manage') && (
                  <Link to="/admin" className="text-muted-foreground hover:text-foreground">
                    管理
                  </Link>
                )}
                <span className="text-muted-foreground">{me.data.email}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    clearToken();
                    qc.clear();
                    nav({ to: '/login' });
                  }}
                >
                  退出
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1 container mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
