import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { api, getToken, openTaskStream } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';

export const Route = createFileRoute('/admin_/operations_/$taskId')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: OperationTaskDetailPage,
});

type TaskDetail = Awaited<ReturnType<typeof api.taskStatus>>;

const TERMINAL = new Set(['success', 'failed', 'partial', 'cancelled']);

function OperationTaskDetailPage() {
  const { taskId } = Route.useParams();
  const qc = useQueryClient();
  const queryKey = useMemo(() => ['admin', 'task-detail', taskId] as const, [taskId]);
  const q = useQuery({
    queryKey,
    queryFn: () => api.taskStatus(taskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'running' || status === 'pending' ? 2000 : false;
    },
  });
  const currentStatus = q.data?.status;

  useEffect(() => {
    if (!taskId) return;
    if (currentStatus && TERMINAL.has(currentStatus)) return;
    const stream = openTaskStream(taskId);
    stream.addEventListener('progress', (event) => {
      try {
        const snap = JSON.parse((event as MessageEvent).data) as Pick<
          TaskDetail,
          'taskId' | 'total' | 'success' | 'failed' | 'status' | 'updatedAt'
        >;
        qc.setQueryData<TaskDetail>(queryKey, (current) =>
          current
            ? {
                ...current,
                total: snap.total,
                success: snap.success,
                failed: snap.failed,
                status: snap.status,
                updatedAt: snap.updatedAt,
              }
            : current,
        );
        if (TERMINAL.has(snap.status)) {
          stream.close();
          void qc.invalidateQueries({ queryKey });
        }
      } catch {
        /* ignore malformed progress event */
      }
    });
    stream.onerror = () => {
      stream.close();
    };
    return () => stream.close();
  }, [currentStatus, qc, queryKey, taskId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/operations">
            <ArrowLeft className="mr-2 h-4 w-4" />
            任务历史
          </Link>
        </Button>
        <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </div>

      <header>
        <div className="text-sm text-muted-foreground">任务详情</div>
        <h1 className="mt-1 break-all text-xl font-semibold">{taskId}</h1>
      </header>

      <TaskDetailPanel
        taskId={taskId}
        detail={q.data ?? null}
        loading={q.isLoading || q.isFetching}
        error={q.error}
      />
    </div>
  );
}
