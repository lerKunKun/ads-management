import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

export const PAGE_SIZE = 100;
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export function usePagination<T>(items: T[], pageSize = PAGE_SIZE, resetKey?: string | number) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  useEffect(() => {
    setPage((current) => Math.min(Math.max(current, 1), pageCount));
  }, [pageCount]);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const pageItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  const goToPage = useCallback(
    (nextPage: number) => {
      setPage(Math.min(Math.max(nextPage, 1), pageCount));
    },
    [pageCount],
  );

  return { page, pageCount, pageItems, pageSize, setPage: goToPage };
}

export function Pagination({
  page,
  pageCount,
  total,
  pageSize = PAGE_SIZE,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize?: number;
  pageSizeOptions?: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const canPaginate = total > pageSize;
  const canChangePageSize = total > 0 && !!onPageSizeChange && !!pageSizeOptions?.length;
  if (!canPaginate && !canChangePageSize) return null;

  const start = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-col gap-3 border-t px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>
          {start}-{end} / {total} 条
        </span>
        {canChangePageSize && (
          <label className="inline-flex items-center gap-1 whitespace-nowrap">
            <span>每页</span>
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <span>条</span>
          </label>
        )}
      </div>
      {canPaginate && (
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
          <span className="col-span-2 text-center text-sm text-muted-foreground sm:col-span-1 sm:min-w-14">
            {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            className="w-full sm:min-w-16 sm:w-auto"
            disabled={page <= 1}
            onClick={() => onPageChange(1)}
          >
            首页
          </Button>
          <Button
            variant="outline"
            className="w-full sm:min-w-20 sm:w-auto"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            className="w-full sm:min-w-20 sm:w-auto"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
          </Button>
          <Button
            variant="outline"
            className="w-full sm:min-w-16 sm:w-auto"
            disabled={page >= pageCount}
            onClick={() => onPageChange(pageCount)}
          >
            末页
          </Button>
        </div>
      )}
    </div>
  );
}
