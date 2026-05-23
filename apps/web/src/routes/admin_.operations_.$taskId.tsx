import { createFileRoute, redirect, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { api, getToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';

export const Route = createFileRoute('/admin_/operations_/$taskId')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  component: OperationTaskDetailPage,
});

function OperationTaskDetailPage() {
  const { taskId } = Route.useParams();
  const q = useQuery({
    queryKey: ['admin', 'task-detail', taskId],
    queryFn: () => api.taskStatus(taskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'running' || status === 'pending' ? 2000 : false;
    },
  });

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
