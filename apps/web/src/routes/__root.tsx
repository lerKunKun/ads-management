import { Outlet, createRootRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, clearToken, getToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';

export const Route = createRootRoute({
  component: RootLayout,
});

const ADMIN_ROLES = new Set(['CompanyAdmin', 'PlatformAdmin']);

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
  const currentAnnouncement = useQuery({
    queryKey: ['release-announcement', 'current', me.data?.id],
    queryFn: api.currentReleaseAnnouncement,
    enabled: hasToken && !!me.data,
    retry: false,
  });
  const markAnnouncementRead = useMutation({
    mutationFn: api.markReleaseAnnouncementRead,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['release-announcement', 'current'] });
    },
  });
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const isAdmin = me.data?.roles.some((role) => ADMIN_ROLES.has(role)) ?? false;

  useEffect(() => {
    setAnnouncementOpen(!!currentAnnouncement.data);
  }, [currentAnnouncement.data?.id]);

  function closeAnnouncement() {
    const id = currentAnnouncement.data?.id;
    setAnnouncementOpen(false);
    if (id && !markAnnouncementRead.isPending) markAnnouncementRead.mutate(id);
  }

  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-2 px-3 py-2 sm:px-4 md:h-14 md:flex-row md:items-center md:justify-between md:py-0 lg:px-6">
          <Link to="/" className="shrink-0 font-semibold">
            广告管理系统
          </Link>
          <nav className="flex min-w-0 items-center gap-2 overflow-x-auto pb-1 text-sm md:justify-end md:overflow-visible md:pb-0">
            {hasToken && me.data && (
              <>
                <Link to="/ad-accounts" className="shrink-0 text-muted-foreground hover:text-foreground">
                  广告账户
                </Link>
                <Link to="/fb-accounts" className="shrink-0 text-muted-foreground hover:text-foreground">
                  FB个人号
                </Link>
                <Link to="/operations" className="shrink-0 text-muted-foreground hover:text-foreground">
                  我的任务
                </Link>
                <Link to="/archives" className="shrink-0 text-muted-foreground hover:text-foreground">
                  我的归档
                </Link>
                {isAdmin && (
                  <Link to="/admin" className="shrink-0 text-muted-foreground hover:text-foreground">
                    管理
                  </Link>
                )}
                <span className="max-w-40 shrink truncate text-muted-foreground sm:max-w-56">{me.data.email}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
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
      <main className="mx-auto w-full max-w-screen-2xl min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-6 lg:px-6">
        <Outlet />
      </main>
      {currentAnnouncement.data && (
        <Dialog
          open={announcementOpen}
          onOpenChange={(open) => {
            if (!open) closeAnnouncement();
          }}
          title={currentAnnouncement.data.title}
        >
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {currentAnnouncement.data.version}
              </span>
              {currentAnnouncement.data.nextUpdateAt && (
                <span className="text-xs text-muted-foreground">
                  下次更新时间：
                  {new Date(currentAnnouncement.data.nextUpdateAt).toLocaleString()}
                </span>
              )}
            </div>
            <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 leading-6">
              {currentAnnouncement.data.content}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={closeAnnouncement} disabled={markAnnouncementRead.isPending}>
              我知道了
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
