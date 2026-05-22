import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, setToken } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api.login(email, password);
      setToken(r.token);
      nav({ to: '/' });
    } catch (e) {
      setErr((e as Error).message || '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-16">
      <h1 className="text-2xl font-semibold mb-6">登录</h1>
      <form className="space-y-3" onSubmit={onSubmit}>
        <div>
          <label className="text-sm text-muted-foreground">邮箱</label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground">密码</label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? '登录中…' : '登录'}
        </Button>
      </form>
    </div>
  );
}
