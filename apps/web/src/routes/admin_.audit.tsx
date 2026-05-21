import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import { api, getToken } from '@/lib/api';
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

export const Route = createFileRoute('/admin_/audit')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: AuditPage,
});

function AuditPage() {
  const [actionFilter, setActionFilter] = useState('');
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'audit', actionFilter],
    queryFn: () =>
      api.listAudit({ limit: 500, ...(actionFilter ? { action: actionFilter } : {}) }),
  });
  const data = q.data ?? [];

  const filtered = useMemo(
    () =>
      data.filter(
        (item) =>
          matchText(item.action, search) ||
          matchText(item.resource, search) ||
          matchText(item.detail ? JSON.stringify(item.detail) : '', search),
      ),
    [data, search],
  );

  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    data.forEach((item) => set.add(item.action));
    return [
      { value: '', label: '全部 action' },
      ...Array.from(set)
        .sort()
        .map((value) => ({ value, label: value })),
    ];
  }, [data]);
  const pager = usePagination(filtered);

  return (
    <div className="space-y-6">
      <div className="text-sm text-muted-foreground">
        <Link to="/admin" className="hover:text-foreground">
          返回管理中心
        </Link>
      </div>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileText className="h-4 w-4" />
            <span>审计日志</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold">全局审计</h1>
        </div>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </header>

      {q.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      )}

      <SearchFilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索 action / resource / detail"
        filters={[
          {
            key: 'action',
            label: 'action',
            value: actionFilter,
            onChange: setActionFilter,
            options: actionOptions,
          },
        ]}
        total={data.length}
        filtered={filtered.length}
        onReset={() => {
          setSearch('');
          setActionFilter('');
        }}
      />

      <div className="overflow-hidden rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>action</TableHead>
              <TableHead>resource</TableHead>
              <TableHead>detail</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && <EmptyRow text="加载中..." />}
            {!q.isLoading && data.length === 0 && <EmptyRow text="暂无审计记录" />}
            {!q.isLoading && data.length > 0 && filtered.length === 0 && (
              <EmptyRow text="无匹配项" />
            )}
            {pager.pageItems.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">{item.action}</TableCell>
                <TableCell className="font-mono text-xs">{item.resource}</TableCell>
                <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                  {item.detail ? JSON.stringify(item.detail) : '-'}
                </TableCell>
                <TableCell className="text-xs">{item.ip ?? '-'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(item.createdAt).toLocaleString()}
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
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <TableRow>
      <TableCell colSpan={5} className="text-muted-foreground">
        {text}
      </TableCell>
    </TableRow>
  );
}
