import { Outlet, createRootRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, clearToken, getToken, type ReleaseAnnouncement } from '@/lib/api';
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
    refetchInterval: hasToken && !!me.data ? 15000 : false,
  });
  const [inboxOpen, setInboxOpen] = useState(false);
  const announcementHistory = useQuery({
    queryKey: ['announcements', 'history', me.data?.id],
    queryFn: api.listPublishedAnnouncements,
    enabled: hasToken && !!me.data && inboxOpen,
    retry: false,
  });
  const markAnnouncementRead = useMutation({
    mutationFn: api.markReleaseAnnouncementRead,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['release-announcement', 'current'] });
      qc.invalidateQueries({ queryKey: ['announcements', 'history'] });
    },
  });
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<ReleaseAnnouncement | null>(null);
  const isAdmin = me.data?.roles.some((role) => ADMIN_ROLES.has(role)) ?? false;
  const unreadAnnouncement = currentAnnouncement.data;
  const dialogAnnouncement = selectedAnnouncement ?? (announcementOpen ? unreadAnnouncement : null);
  const hasUnreadAnnouncement = !!unreadAnnouncement;

  useEffect(() => {
    if (currentAnnouncement.data) setAnnouncementOpen(true);
  }, [currentAnnouncement.data?.id]);

  function closeAnnouncement() {
    const id = dialogAnnouncement?.id;
    setAnnouncementOpen(false);
    setSelectedAnnouncement(null);
    if (id && id === unreadAnnouncement?.id && !markAnnouncementRead.isPending) {
      markAnnouncementRead.mutate(id);
    }
  }

  function openHistoryAnnouncement(announcement: ReleaseAnnouncement) {
    setSelectedAnnouncement(announcement);
    setAnnouncementOpen(false);
    setInboxOpen(false);
  }

  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-2 px-3 py-2 sm:px-4 md:h-14 md:flex-row md:items-center md:justify-between md:py-0 lg:px-6">
          <Link to="/" className="shrink-0 font-semibold">
            广告管理系统
          </Link>
          <nav className="flex min-w-0 flex-wrap items-center gap-2 overflow-visible pb-1 text-sm md:justify-end md:pb-0">
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
                <div className="relative shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="relative h-8 gap-1.5 px-2"
                    onClick={() => setInboxOpen((current) => !current)}
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    站内信
                    {hasUnreadAnnouncement && (
                      <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />
                    )}
                  </Button>
                  {inboxOpen && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-md border bg-background shadow-lg">
                      <div className="flex items-center justify-between border-b px-3 py-2">
                        <span className="text-sm font-medium">站内信历史</span>
                        {hasUnreadAnnouncement && (
                          <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-600">
                            有新消息
                          </span>
                        )}
                      </div>
                      <div className="max-h-96 overflow-y-auto">
                        {announcementHistory.isLoading && (
                          <div className="px-3 py-4 text-sm text-muted-foreground">加载中...</div>
                        )}
                        {!announcementHistory.isLoading && (announcementHistory.data?.length ?? 0) === 0 && (
                          <div className="px-3 py-4 text-sm text-muted-foreground">暂无站内信</div>
                        )}
                        {(announcementHistory.data ?? []).map((announcement) => {
                          const unread = announcement.id === unreadAnnouncement?.id;
                          return (
                            <button
                              key={announcement.id}
                              type="button"
                              className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/50"
                              onClick={() => openHistoryAnnouncement(announcement)}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-sm font-medium">{announcement.title}</span>
                                {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <span>{announcement.version}</span>
                                <span>{formatAnnouncementDate(announcement.publishedAt)}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
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
      {dialogAnnouncement && (
        <Dialog
          open={!!dialogAnnouncement}
          onOpenChange={(open) => {
            if (!open) closeAnnouncement();
          }}
          title={dialogAnnouncement.title}
        >
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                标识：{dialogAnnouncement.version}
              </span>
              {dialogAnnouncement.nextUpdateAt && (
                <span className="text-xs text-muted-foreground">
                  计划时间：
                  {new Date(dialogAnnouncement.nextUpdateAt).toLocaleString()}
                </span>
              )}
            </div>
            <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 leading-6">
              {dialogAnnouncement.content}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={closeAnnouncement} disabled={markAnnouncementRead.isPending}>
              关闭
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function formatAnnouncementDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '未发布';
}
