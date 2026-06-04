import { Outlet, createRootRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Megaphone } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, clearToken, getToken, type ReleaseAnnouncement } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const Route = createRootRoute({
  component: RootLayout,
});

const ADMIN_ROLES = new Set(['CompanyAdmin', 'PlatformAdmin']);
const JAX_TASK_URL = 'https://jax.biounetwork.com/';

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
    staleTime: 60_000,
    refetchInterval: hasToken && !!me.data ? 120_000 : false,
  });
  const announcementHistory = useQuery({
    queryKey: ['announcements', 'history', me.data?.id],
    queryFn: api.listPublishedAnnouncements,
    enabled: hasToken && !!me.data,
    retry: false,
    staleTime: 300_000,
    refetchInterval: hasToken && !!me.data ? 300_000 : false,
  });
  const markAnnouncementRead = useMutation({
    mutationFn: api.markReleaseAnnouncementRead,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['release-announcement', 'current'] });
      qc.invalidateQueries({ queryKey: ['announcements', 'history'] });
    },
  });
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [selectedAnnouncementId, setSelectedAnnouncementId] = useState<string | null>(null);
  const isAdmin = me.data?.roles.some((role) => ADMIN_ROLES.has(role)) ?? false;
  const unreadAnnouncement = currentAnnouncement.data;
  const announcements = useMemo(() => {
    const rows = announcementHistory.data ?? [];
    if (unreadAnnouncement && !rows.some((item) => item.id === unreadAnnouncement.id)) {
      return [unreadAnnouncement, ...rows];
    }
    return rows;
  }, [announcementHistory.data, unreadAnnouncement]);
  const latestAnnouncement = announcements[0] ?? null;
  const selectedAnnouncement =
    announcements.find((announcement) => announcement.id === selectedAnnouncementId) ??
    latestAnnouncement;
  const hasUnreadLatest = !!unreadAnnouncement && unreadAnnouncement.id === latestAnnouncement?.id;

  function openAnnouncementCenter(announcement?: ReleaseAnnouncement) {
    setSelectedAnnouncementId(announcement?.id ?? latestAnnouncement?.id ?? null);
    setAnnouncementOpen(true);
  }

  function confirmAnnouncement() {
    setAnnouncementOpen(false);
    if (
      unreadAnnouncement?.id &&
      unreadAnnouncement.id === latestAnnouncement?.id &&
      !markAnnouncementRead.isPending
    ) {
      markAnnouncementRead.mutate(unreadAnnouncement.id);
    }
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
                {!isAdmin && (
                  <Link to="/permission-requests" className="shrink-0 text-muted-foreground hover:text-foreground">
                    权限申请
                  </Link>
                )}
                {isAdmin && (
                  <Link to="/admin" className="shrink-0 text-muted-foreground hover:text-foreground">
                    管理
                  </Link>
                )}
              </nav>
              <div className="hidden shrink-0 items-center gap-2 md:flex">
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

      {hasToken && me.data && latestAnnouncement && (
        <button
          type="button"
          className="w-full border-b border-amber-200 bg-amber-50/90 text-left text-amber-950 hover:bg-amber-50"
          onClick={() => openAnnouncementCenter(latestAnnouncement)}
        >
          <div className="mx-auto flex h-10 w-full max-w-screen-2xl min-w-0 items-center justify-between gap-3 px-3 sm:px-4 lg:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <Megaphone className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
              <span className="shrink-0 text-xs font-medium">
                {latestAnnouncement.isPinned ? '置顶站内信' : '最新站内信'}
              </span>
              {hasUnreadLatest && (
                <span className="shrink-0 rounded-full bg-red-600 px-1.5 py-0.5 text-xs text-white">
                  新发布
                </span>
              )}
              <span className="shrink-0 rounded border border-amber-300 bg-white/60 px-1.5 py-0.5 text-xs">
                {latestAnnouncement.version}
              </span>
              <span className="hidden shrink-0 text-xs text-amber-800 sm:inline">
                {formatAnnouncementDate(latestAnnouncement.publishedAt)}
              </span>
              <span className="min-w-0 truncate text-sm font-medium">{latestAnnouncement.title}</span>
            </div>
            <span className="hidden shrink-0 text-xs font-medium text-amber-800 md:inline">
              点击查看当前和历史
            </span>
          </div>
        </button>
      )}

      <main className="mx-auto w-full max-w-screen-2xl min-w-0 flex-1 px-3 py-4 sm:px-4 sm:py-6 lg:px-6">
        <Outlet />
      </main>

      <AnnouncementCenterDialog
        open={announcementOpen}
        announcements={announcements}
        selectedAnnouncement={selectedAnnouncement}
        selectedAnnouncementId={selectedAnnouncement?.id ?? null}
        unreadId={unreadAnnouncement?.id ?? null}
        isLoading={announcementHistory.isLoading}
        isConfirming={markAnnouncementRead.isPending}
        onSelect={(announcement) => setSelectedAnnouncementId(announcement.id)}
        onClose={() => setAnnouncementOpen(false)}
        onConfirm={confirmAnnouncement}
      />
    </div>
  );
}

function AnnouncementCenterDialog({
  open,
  announcements,
  selectedAnnouncement,
  selectedAnnouncementId,
  unreadId,
  isLoading,
  isConfirming,
  onSelect,
  onClose,
  onConfirm,
}: {
  open: boolean;
  announcements: ReleaseAnnouncement[];
  selectedAnnouncement: ReleaseAnnouncement | null;
  selectedAnnouncementId: string | null;
  unreadId: string | null;
  isLoading: boolean;
  isConfirming: boolean;
  onSelect: (announcement: ReleaseAnnouncement) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-lg font-semibold">站内信</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">查看最新通知和历史公告。</p>
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[20rem_1fr]">
          <aside className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
            <div className="border-b px-3 py-2 text-sm font-medium">当前和历史</div>
            <div className="max-h-56 min-h-0 overflow-y-auto p-2 lg:max-h-none lg:flex-1">
              {isLoading && <EmptyAnnouncementState text="加载中..." />}
              {!isLoading && announcements.length === 0 && <EmptyAnnouncementState text="暂无站内信" />}
              {announcements.map((announcement, index) => {
                const selected = announcement.id === selectedAnnouncementId;
                const unread = announcement.id === unreadId;
                return (
                  <button
                    key={announcement.id}
                    type="button"
                    className={cn(
                      'mb-2 block w-full rounded-md border p-3 text-left last:mb-0 hover:bg-muted/50',
                      selected && 'border-primary bg-primary/5',
                    )}
                    onClick={() => onSelect(announcement)}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{announcement.title}</span>
                          {unread && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{announcement.version}</span>
                          <span>{formatAnnouncementDate(announcement.publishedAt)}</span>
                        </div>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 rounded border px-1.5 py-0.5 text-xs',
                          index === 0
                            ? 'border-amber-300 bg-amber-50 text-amber-700'
                            : 'text-muted-foreground',
                        )}
                      >
                  {announcement.isPinned ? '置顶' : index === 0 ? '最新' : '历史'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="flex min-h-[28rem] flex-col overflow-hidden lg:min-h-0">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {!selectedAnnouncement && <EmptyAnnouncementState text="请选择站内信" />}
              {selectedAnnouncement && (
                <div className="space-y-4 text-sm">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words text-lg font-semibold">{selectedAnnouncement.title}</h3>
                      {selectedAnnouncement.id === unreadId && (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-600">
                          新发布
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-primary">
                        标识：{selectedAnnouncement.version}
                      </span>
                      <span>发布时间：{formatAnnouncementDate(selectedAnnouncement.publishedAt)}</span>
                      {selectedAnnouncement.nextUpdateAt && (
                        <span>计划时间：{new Date(selectedAnnouncement.nextUpdateAt).toLocaleString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 leading-6">
                    {selectedAnnouncement.content}
                  </div>
                </div>
              )}
            </div>
            <div className="border-t bg-muted/20 p-3">
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" asChild>
                  <a href={JAX_TASK_URL} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    有问题给Jax加任务
                  </a>
                </Button>
                <Button onClick={onConfirm} disabled={!selectedAnnouncement || isConfirming}>
                  {isConfirming ? '确认中...' : '确认'}
                </Button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function EmptyAnnouncementState({ text }: { text: string }) {
  return <div className="flex min-h-24 items-center justify-center p-4 text-sm text-muted-foreground">{text}</div>;
}

function formatAnnouncementDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '未发布';
}
