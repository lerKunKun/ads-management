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
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <Link to="/" className="font-semibold">
            广告管理系统
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            {hasToken && me.data && (
              <>
                <Link to="/ad-accounts" className="text-muted-foreground hover:text-foreground">
                  广告账户
                </Link>
                <Link to="/fb-accounts" className="text-muted-foreground hover:text-foreground">
                  广告账户组
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
      <main className="container mx-auto flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
