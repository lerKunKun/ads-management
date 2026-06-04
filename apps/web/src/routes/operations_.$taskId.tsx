import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { ArrowLeft, Pause, Play, RefreshCw, Square } from 'lucide-react';
import { api, getToken, openTaskStream } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';

export const Route = createFileRoute('/operations_/$taskId')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: MyOperationTaskDetailPage,
});

type TaskDetail = Awaited<ReturnType<typeof api.taskStatus>>;

const TERMINAL = new Set(['success', 'failed', 'partial', 'cancelled']);

function MyOperationTaskDetailPage() {
  const { taskId } = Route.useParams();
  const qc = useQueryClient();
  const queryKey = useMemo(() => ['my', 'task-detail', taskId] as const, [taskId]);
  const q = useQuery({
    queryKey,
    queryFn: () => api.taskStatus(taskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'running' || status === 'pending' ? 30000 : false;
    },
  });
  const currentStatus = q.data?.status;
  const pause = useMutation({
    mutationFn: () => api.pauseTask(taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const resume = useMutation({
    mutationFn: () => api.resumeTask(taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const stop = useMutation({
    mutationFn: () => api.stopTask(taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });
  const actionBusy = pause.isPending || resume.isPending || stop.isPending;
  const canPause = currentStatus === 'pending' || currentStatus === 'running';
  const canResume = currentStatus === 'paused';
  const canStop = currentStatus === 'pending' || currentStatus === 'running' || currentStatus === 'paused';
  const actionError = pause.error ?? resume.error ?? stop.error;

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
        <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
          <Link to="/operations">
            <ArrowLeft className="mr-2 h-4 w-4" />
            我的任务
          </Link>
        </Button>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          {canPause ? (
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => pause.mutate()} disabled={actionBusy}>
              <Pause className="mr-2 h-4 w-4" />
              暂停
            </Button>
          ) : null}
          {canResume ? (
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => resume.mutate()} disabled={actionBusy}>
              <Play className="mr-2 h-4 w-4" />
              恢复
            </Button>
          ) : null}
          {canStop ? (
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => stop.mutate()} disabled={actionBusy}>
              <Square className="mr-2 h-4 w-4" />
              停止
            </Button>
          ) : null}
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        </div>
      </div>
      {actionError ? (
        <p className="text-sm text-destructive">{(actionError as Error).message}</p>
      ) : null}

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
