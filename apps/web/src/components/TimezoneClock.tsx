import { useEffect, useMemo, useState } from 'react';

export function TimezoneClock({
  timezone,
  label = '账户时区当前时间',
}: {
  timezone?: string | null;
  label?: string;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const formatted = useMemo(() => formatTimezoneTime(now, timezone), [now, timezone]);

  return (
    <div className="w-full rounded-md border bg-background px-3 py-2 text-left sm:w-auto sm:text-right">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-medium tabular-nums">{formatted.time}</div>
      <div className="mt-0.5 max-w-full truncate text-xs text-muted-foreground sm:max-w-[220px]">
        {formatted.timezone}
      </div>
    </div>
  );
}

function formatTimezoneTime(now: Date, timezone: string | null | undefined) {
  if (!timezone) {
    return { time: '-', timezone: '未配置时区' };
  }
  try {
    return {
      time: new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(now),
      timezone,
    };
  } catch {
    return { time: '-', timezone };
  }
}
