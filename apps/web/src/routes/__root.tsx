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
          <div className="flex min-w-0 items-center justify-between gap-2 md:w-auto">
            <Link to="/" className="min-w-0 truncate font-semibold">
              广告管理系统
            </Link>
            {hasToken && me.data && (
              <div className="flex shrink-0 items-center gap-1 md:hidden">
                <AnnouncementInbox
                  open={inboxOpen}
                  setOpen={setInboxOpen}
                  hasUnread={hasUnreadAnnouncement}
                  isLoading={announcementHistory.isLoading}
                  announcements={announcementHistory.data ?? []}
                  unreadId={unreadAnnouncement?.id ?? null}
                  onOpenAnnouncement={openHistoryAnnouncement}
                  compact
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 px-2"
                  onClick={() => {
                    clearToken();
                    qc.clear();
                    nav({ to: '/login' });
                  }}
                >
                  退出
                </Button>
              </div>
            )}
          </div>
          {hasToken && me.data && (
            <div className="flex min-w-0 flex-col gap-2 md:flex-1 md:flex-row md:items-center md:justify-end">
              <nav className="flex min-w-0 items-center gap-2 overflow-x-auto overflow-y-hidden pb-1 text-sm [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:justify-end md:overflow-visible md:pb-0 [&::-webkit-scrollbar]:hidden">
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
              </nav>
              <div className="hidden shrink-0 items-center gap-2 md:flex">
                <AnnouncementInbox
                  open={inboxOpen}
                  setOpen={setInboxOpen}
                  hasUnread={hasUnreadAnnouncement}
                  isLoading={announcementHistory.isLoading}
                  announcements={announcementHistory.data ?? []}
                  unreadId={unreadAnnouncement?.id ?? null}
                  onOpenAnnouncement={openHistoryAnnouncement}
                />
                <span className="max-w-40 shrink truncate text-muted-foreground lg:max-w-56">{me.data.email}</span>
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
              </div>
            </div>
          )}
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

function AnnouncementInbox({
  open,
  setOpen,
  hasUnread,
  isLoading,
  announcements,
  unreadId,
  onOpenAnnouncement,
  compact = false,
}: {
  open: boolean;
  setOpen: (updater: boolean | ((current: boolean) => boolean)) => void;
  hasUnread: boolean;
  isLoading: boolean;
  announcements: ReleaseAnnouncement[];
  unreadId: string | null;
  onOpenAnnouncement: (announcement: ReleaseAnnouncement) => void;
  compact?: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={`relative h-8 gap-1.5 ${compact ? 'w-8 px-0' : 'px-2'}`}
        onClick={() => setOpen((current) => !current)}
        title="站内信"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {!compact && <span>站内信</span>}
        {hasUnread && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />
        )}
      </Button>
      {open && (
        <div
          className={
            compact
              ? 'fixed left-3 right-3 top-14 z-50 overflow-hidden rounded-md border bg-background shadow-lg'
              : 'absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-md border bg-background shadow-lg'
          }
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">站内信历史</span>
            {hasUnread && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-600">
                有新消息
              </span>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {isLoading && (
              <div className="px-3 py-4 text-sm text-muted-foreground">加载中...</div>
            )}
            {!isLoading && announcements.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground">暂无站内信</div>
            )}
            {announcements.map((announcement) => {
              const unread = announcement.id === unreadId;
              return (
                <button
                  key={announcement.id}
                  type="button"
                  className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/50"
                  onClick={() => onOpenAnnouncement(announcement)}
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
  );
}
