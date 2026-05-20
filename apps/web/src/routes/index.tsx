import { createFileRoute, redirect } from '@tanstack/react-router';
import { getToken } from '@/lib/api';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
    throw redirect({ to: '/fb-accounts' });
  },
});
