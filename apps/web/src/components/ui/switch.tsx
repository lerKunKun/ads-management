import * as React from 'react';
import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
  size?: 'sm' | 'md';
}

/** shadcn 风格 toggle 开关。MVP 自实现避免引 radix。 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    { checked, onCheckedChange, disabled, className, size = 'md', ...rest },
    ref,
  ) => {
    const isSm = size === 'sm';
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={rest['aria-label']}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onCheckedChange(!checked);
        }}
        className={cn(
          'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          isSm ? 'h-5 w-9' : 'h-6 w-11',
          checked ? 'bg-emerald-500' : 'bg-input',
          className,
        )}
      >
        <span
          className={cn(
            'pointer-events-none block rounded-full bg-background shadow-lg ring-0 transition-transform',
            isSm ? 'h-4 w-4' : 'h-5 w-5',
            checked
              ? isSm ? 'translate-x-4' : 'translate-x-5'
              : 'translate-x-0',
          )}
        />
      </button>
    );
  },
);
Switch.displayName = 'Switch';
