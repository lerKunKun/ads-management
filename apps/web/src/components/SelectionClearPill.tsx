import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectionClearPillProps {
  count: number;
  itemLabel: string;
  onClear: () => void;
  prefix?: string;
  detail?: string;
  className?: string;
}

export function SelectionClearPill({
  count,
  itemLabel,
  onClear,
  prefix = '已选',
  detail,
  className,
}: SelectionClearPillProps) {
  if (count <= 0) return null;

  return (
    <button
      type="button"
      className={cn(
        'group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:border-primary/40 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        className,
      )}
      title={`清除已选${itemLabel}`}
      aria-label={`清除已选${itemLabel}`}
      onClick={(event) => {
        event.stopPropagation();
        onClear();
      }}
    >
      <span className="whitespace-nowrap">
        {prefix} {count} 项
      </span>
      {detail && (
        <span className="whitespace-nowrap text-[11px] font-normal text-primary/70">
          {detail}
        </span>
      )}
      <X className="h-3.5 w-3.5 opacity-70 transition-opacity group-hover:opacity-100" aria-hidden="true" />
    </button>
  );
}
