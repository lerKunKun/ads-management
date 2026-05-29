import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Megaphone,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  getToken,
  type Me,
  type ReleaseAnnouncement,
  type ReleaseAnnouncementInput,
  type ReleaseAnnouncementStatus,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SearchFilterBar, matchText } from '@/components/SearchFilterBar';
import { Pagination, usePagination } from '@/components/Pagination';

export const Route = createFileRoute('/admin_/announcements')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AnnouncementsPage,
});

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'draft', label: '草稿' },
  { value: 'published', label: '已发布' },
  { value: 'archived', label: '已归档' },
];

function AnnouncementsPage() {
  const qc = useQueryClient();
  const me = useQuery<Me>({ queryKey: ['me'], queryFn: api.me });
  const isPlatformAdmin = me.data?.roles.includes('PlatformAdmin') ?? false;
  const announcementsQ = useQuery({
    queryKey: ['admin', 'release-announcements'],
    queryFn: api.listReleaseAnnouncements,
    enabled: isPlatformAdmin,
  });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ReleaseAnnouncement | null>(null);
  const [deleting, setDeleting] = useState<ReleaseAnnouncement | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'release-announcements'] });
    qc.invalidateQueries({ queryKey: ['release-announcement', 'current'] });
  };

  const create = useMutation({
    mutationFn: api.createReleaseAnnouncement,
    onSuccess: () => {
      setCreating(false);
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<ReleaseAnnouncementInput> }) =>
      api.updateReleaseAnnouncement(id, patch),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });
  const publish = useMutation({
    mutationFn: api.publishReleaseAnnouncement,
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: api.archiveReleaseAnnouncement,
    onSuccess: invalidate,
  });
  const deleteAnnouncement = useMutation({
    mutationFn: api.deleteReleaseAnnouncement,
    onSuccess: () => {
      setDeleting(null);
      invalidate();
    },
  });

  const announcements = announcementsQ.data ?? [];
  const filtered = useMemo(
    () =>
      announcements.filter(
        (item) =>
          (!statusFilter || item.status === statusFilter) &&
          [item.title, item.version, item.content].some((value) => matchText(value, search)),
      ),
    [announcements, search, statusFilter],
  );
  const pager = usePagination(filtered);

  const error =
    (me.error as Error | null)?.message ??
    (announcementsQ.error as Error | null)?.message ??
    (create.error as Error | null)?.message ??
    (update.error as Error | null)?.message ??
    (publish.error as Error | null)?.message ??
    (archive.error as Error | null)?.message ??
    (deleteAnnouncement.error as Error | null)?.message;

  if (me.data && !isPlatformAdmin) {
    return (
      <div className="space-y-4">
        <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground">
          返回管理中心
        </Link>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          只有平台超管可以发布和管理站内信。
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link to="/admin" className="hover:text-foreground">
          返回管理中心
        </Link>
      </div>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Megaphone className="h-4 w-4" />
            <span>站内信发布</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">版本更新弹窗</h1>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => announcementsQ.refetch()}
            disabled={announcementsQ.isFetching}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
          <Button size="sm" className="w-full sm:w-auto" onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" />
            新建站内信
          </Button>
        </div>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索标题、版本或内容"
        filters={[
          {
            key: 'status',
            label: '状态',
            value: statusFilter,
            onChange: setStatusFilter,
            options: STATUS_OPTIONS,
          },
        ]}
        total={announcements.length}
        filtered={filtered.length}
        onReset={() => {
          setSearch('');
          setStatusFilter('');
        }}
      />

      <div className="overflow-hidden rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>标题</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>下次更新时间</TableHead>
              <TableHead>发布时间</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {announcementsQ.isLoading && <EmptyRow text="加载中..." />}
            {!announcementsQ.isLoading && announcements.length === 0 && (
              <EmptyRow text="暂无站内信" />
            )}
            {!announcementsQ.isLoading && announcements.length > 0 && filtered.length === 0 && (
              <EmptyRow text="无匹配项" />
            )}
            {pager.pageItems.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">{item.version}</TableCell>
                <TableCell>
                  <div className="max-w-xs truncate font-medium">{item.title}</div>
                  <div className="mt-1 max-w-xs truncate text-xs text-muted-foreground">
                    {item.content}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(item.nextUpdateAt)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(item.publishedAt)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(item.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(item)}>
                      <Pencil className="mr-1 h-3 w-3" />
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={publish.isPending}
                      onClick={() => publish.mutate(item.id)}
                    >
                      <Send className="mr-1 h-3 w-3" />
                      {item.status === 'published' ? '重新发布' : '发布'}
                    </Button>
                    {item.status !== 'archived' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={archive.isPending}
                        onClick={() => archive.mutate(item.id)}
                      >
                        <Archive className="mr-1 h-3 w-3" />
                        归档
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10"
                      disabled={deleteAnnouncement.isPending}
                      onClick={() => setDeleting(item)}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pagination
          page={pager.page}
          pageCount={pager.pageCount}
          total={filtered.length}
          onPageChange={pager.setPage}
        />
      </div>

      <AnnouncementFormDialog
        open={creating}
        mode="create"
        submitting={create.isPending}
        onCancel={() => setCreating(false)}
        onSubmit={(args) => create.mutate(args)}
      />
      <AnnouncementFormDialog
        open={!!editing}
        mode="edit"
        announcement={editing}
        submitting={update.isPending}
        onCancel={() => setEditing(null)}
        onSubmit={(args) => editing && update.mutate({ id: editing.id, patch: args })}
      />
      <DeleteAnnouncementDialog
        announcement={deleting}
        submitting={deleteAnnouncement.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && deleteAnnouncement.mutate(deleting.id)}
      />
    </div>
  );
}

function AnnouncementFormDialog({
  open,
  mode,
  announcement,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  announcement?: ReleaseAnnouncement | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (args: ReleaseAnnouncementInput) => void;
}) {
  const [title, setTitle] = useState('');
  const [version, setVersion] = useState('');
  const [content, setContent] = useState('');
  const [nextUpdateAt, setNextUpdateAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(announcement?.title ?? '');
    setVersion(announcement?.version ?? '');
    setContent(announcement?.content ?? '');
    setNextUpdateAt(announcement?.nextUpdateAt ? new Date(announcement.nextUpdateAt) : null);
  }, [announcement, open]);

  const canSubmit =
    !!title.trim() &&
    !!version.trim() &&
    !!content.trim() &&
    title.trim().length <= 120 &&
    version.trim().length <= 80 &&
    content.trim().length <= 4000;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && onCancel()}
      title={mode === 'create' ? '新建站内信' : '编辑站内信'}
    >
      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground">版本</label>
          <Input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="例如 v2026.05.29"
            maxLength={80}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">标题</label>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如 系统更新说明"
            maxLength={120}
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">更新内容</label>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={8}
            maxLength={4000}
            className="mt-1 min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            placeholder="填写本次更新内容"
          />
          <div className="mt-1 text-right text-xs text-muted-foreground">{content.length} / 4000</div>
        </div>
        <div>
          <label className="text-sm text-muted-foreground">下次更新时间</label>
          <DateTimePicker value={nextUpdateAt} onChange={setNextUpdateAt} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button
          disabled={submitting || !canSubmit}
          onClick={() =>
            onSubmit({
              title: title.trim(),
              version: version.trim(),
              content: content.trim(),
              nextUpdateAt: nextUpdateAt ? nextUpdateAt.toISOString() : '',
            })
          }
        >
          {submitting ? '保存中...' : '保存'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DateTimePicker({
  value,
  onChange,
}: {
  value: Date | null;
  onChange: (value: Date | null) => void;
}) {
  const [month, setMonth] = useState(() => startOfMonth(value ?? new Date()));

  useEffect(() => {
    if (value) setMonth(startOfMonth(value));
  }, [value]);

  const days = useMemo(() => buildCalendarDays(month), [month]);
  const selectedHour = value?.getHours() ?? 10;
  const selectedMinute = value?.getMinutes() ?? 0;

  function selectDate(day: Date) {
    const next = new Date(day);
    next.setHours(selectedHour, selectedMinute, 0, 0);
    onChange(next);
  }

  function updateTime(part: 'hour' | 'minute', nextValue: string) {
    if (!value) return;
    const next = new Date(value);
    if (part === 'hour') next.setHours(Number(nextValue));
    if (part === 'minute') next.setMinutes(Number(nextValue));
    next.setSeconds(0, 0);
    onChange(next);
  }

  return (
    <div className="mt-1 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {month.getFullYear()} 年 {month.getMonth() + 1} 月
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setMonth(addMonths(month, -1))}
            title="上个月"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setMonth(addMonths(month, 1))}
            title="下个月"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
          <div key={day} className="py-1">
            {day}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((day, index) =>
          day ? (
            <button
              key={day.toISOString()}
              type="button"
              className={[
                'flex h-8 items-center justify-center rounded-md border text-sm transition-colors',
                isSameDate(day, value)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-transparent hover:border-input hover:bg-muted',
                isToday(day) && !isSameDate(day, value) ? 'text-primary' : '',
              ].join(' ')}
              onClick={() => selectDate(day)}
            >
              {day.getDate()}
            </button>
          ) : (
            <div key={`empty-${index}`} className="h-8" />
          ),
        )}
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
        <select
          value={pad2(selectedHour)}
          disabled={!value}
          onChange={(event) => updateTime('hour', event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:bg-muted"
        >
          {Array.from({ length: 24 }, (_, hour) => (
            <option key={hour} value={pad2(hour)}>
              {pad2(hour)}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">时</span>
        <select
          value={pad2(selectedMinute)}
          disabled={!value}
          onChange={(event) => updateTime('minute', event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:bg-muted"
        >
          {Array.from({ length: 60 }, (_, minute) => (
            <option key={minute} value={pad2(minute)}>
              {pad2(minute)}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">分</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {value ? `${value.toLocaleDateString()} ${pad2(value.getHours())}:${pad2(value.getMinutes())}` : '未设置'}
        </span>
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            <X className="mr-1 h-3 w-3" />
            清除
          </Button>
        )}
      </div>
    </div>
  );
}

function DeleteAnnouncementDialog({
  announcement,
  submitting,
  onCancel,
  onConfirm,
}: {
  announcement: ReleaseAnnouncement | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={!!announcement}
      onOpenChange={(nextOpen) => !nextOpen && onCancel()}
      title="删除站内信"
    >
      <div className="space-y-2 text-sm">
        <p>确定删除这条站内信吗？</p>
        <p className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {announcement?.version ?? ''} / {announcement?.title ?? ''}
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={submitting}>
          {submitting ? '删除中...' : '删除'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: ReleaseAnnouncementStatus }) {
  const className =
    status === 'published'
      ? 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700'
      : status === 'archived'
        ? 'border-muted-foreground/30 bg-muted text-muted-foreground'
        : 'border-amber-600/30 bg-amber-600/10 text-amber-700';
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-xs ${className}`}>
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status: ReleaseAnnouncementStatus): string {
  if (status === 'published') return '已发布';
  if (status === 'archived') return '已归档';
  return '草稿';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function EmptyRow({ text }: { text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={7} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function buildCalendarDays(month: Date): Array<Date | null> {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1);
  const firstWeekday = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const days: Array<Date | null> = [];

  for (let i = 0; i < firstWeekday; i += 1) days.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push(new Date(year, monthIndex, day));
  }
  while (days.length < 42) days.push(null);
  return days;
}

function isSameDate(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isToday(date: Date): boolean {
  return isSameDate(date, new Date());
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
