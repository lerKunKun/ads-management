import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Archive, Eye, RefreshCw } from 'lucide-react';
import { api, getToken, type ArchivedAd } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
import { metaEntityStatusLabel } from '@/lib/labels';

export const Route = createFileRoute('/archives')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: MyArchivesPage,
});

function MyArchivesPage() {
  const q = useQuery({
    queryKey: ['my', 'archives'],
    queryFn: () => api.myArchives(300),
  });
  const data = q.data ?? [];
  const [search, setSearch] = useState('');
  const [hasPreview, setHasPreview] = useState('');

  const filtered = useMemo(
    () =>
      data.filter((item) => {
        const matched =
          matchText(item.adName, search) ||
          matchText(item.adMetaId, search) ||
          matchText(item.campaignMetaId, search) ||
          matchText(item.adsetMetaId, search);
        const previewMatched =
          hasPreview === 'yes' ? !!item.postUrl : hasPreview === 'no' ? !item.postUrl : true;
        return matched && previewMatched;
      }),
    [data, hasPreview, search],
  );
  const pager = usePagination(filtered);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Archive className="h-4 w-4" />
            <span>个人归档</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">我的归档广告</h1>
        </div>
        <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => q.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </header>

      {q.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      )}

      <section className="overflow-hidden rounded-md border bg-background">
        <div className="border-b p-3">
          <SearchFilterBar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="搜索广告名称、广告 ID、系列 ID、广告组 ID"
            filters={[
              {
                key: 'preview',
                label: '预览',
                value: hasPreview,
                onChange: setHasPreview,
                options: [
                  { value: '', label: '全部' },
                  { value: 'yes', label: '有链接' },
                  { value: 'no', label: '无链接' },
                ],
              },
            ]}
            total={data.length}
            filtered={filtered.length}
            onReset={() => {
              setSearch('');
              setHasPreview('');
            }}
          />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[220px]">广告名称</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>归档时间</TableHead>
              <TableHead>广告 ID</TableHead>
              <TableHead>系列 ID</TableHead>
              <TableHead>广告组 ID</TableHead>
              <TableHead className="text-right">预览</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && <EmptyRow colSpan={7} text="加载中..." />}
            {!q.isLoading && data.length === 0 && <EmptyRow colSpan={7} text="暂无归档广告" />}
            {!q.isLoading && data.length > 0 && filtered.length === 0 && (
              <EmptyRow colSpan={7} text="无匹配归档广告" />
            )}
            {pager.pageItems.map((item) => (
              <ArchiveRow key={item.id} item={item} />
            ))}
          </TableBody>
        </Table>
        <Pagination
          page={pager.page}
          pageCount={pager.pageCount}
          total={filtered.length}
          onPageChange={pager.setPage}
        />
      </section>
    </div>
  );
}

function ArchiveRow({ item }: { item: ArchivedAd }) {
  return (
    <TableRow>
      <TableCell className="min-w-[220px] max-w-[420px] font-medium">
        <span className="block truncate" title={item.adName}>
          {item.adName}
        </span>
      </TableCell>
      <TableCell>{metaEntityStatusLabel(item.status)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {new Date(item.archivedAt).toLocaleString()}
      </TableCell>
      <IdCell value={item.adMetaId} />
      <IdCell value={item.campaignMetaId} />
      <IdCell value={item.adsetMetaId} />
      <TableCell className="text-right">
        {item.postUrl ? (
          <Button
            asChild
            size="sm"
            variant="outline"
            className="h-9 w-9 px-0"
            title="预览帖子"
            aria-label={`预览 ${item.adName}`}
          >
            <a href={item.postUrl} target="_blank" rel="noreferrer">
              <Eye className="h-4 w-4" />
            </a>
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-9 w-9 px-0" disabled title="无预览链接">
            <Eye className="h-4 w-4" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function IdCell({ value }: { value: string | null }) {
  return (
    <TableCell className="max-w-[180px] truncate font-mono text-xs text-muted-foreground" title={value ?? '-'}>
      {value ?? '-'}
    </TableCell>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-24 text-center text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}
