import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, getToken } from '@/lib/api';

export const Route = createFileRoute('/oauth/fb/callback')({
  beforeLoad: () => {
    if (!getToken()) throw redirect({ to: '/login' });
  },
  validateSearch: (s) => ({ code: typeof s['code'] === 'string' ? s['code'] : undefined }),
  component: FbCallback,
});

function FbCallback() {
  const nav = useNavigate();
  const search = Route.useSearch();
  const [msg, setMsg] = useState('处理中…');

  useEffect(() => {
    if (!search.code) {
      setMsg('回调缺少 code 参数');
      return;
    }
    api
      .fbCallback(search.code)
      .then((r) => {
        setMsg(`FB个人号绑定成功，同步广告账户 ${r.adAccountsSynced} 个，3 秒后跳转…`);
        setTimeout(() => nav({ to: '/fb-accounts' }), 3000);
      })
      .catch((e) => setMsg(`绑定失败: ${e.message}`));
  }, [search.code, nav]);

  return <p className="text-muted-foreground">{msg}</p>;
}
