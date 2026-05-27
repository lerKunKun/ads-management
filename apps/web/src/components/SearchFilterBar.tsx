import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterDef {
  key: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
}

interface SearchFilterBarProps {
  searchValue: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder?: string;
  filters?: FilterDef[];
  total?: number;
  filtered?: number;
  onReset?: () => void;
  className?: string;
}

export function SearchFilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = '搜索...',
  filters = [],
  total,
  filtered,
  onReset,
  className,
}: SearchFilterBarProps) {
  const hasFilter = !!searchValue || filters.some((filter) => filter.value !== '');

  return (
    <div className={cn('grid w-full gap-2 sm:flex sm:flex-wrap sm:items-center', className)}>
      <Input
        placeholder={searchPlaceholder}
        value={searchValue}
        onChange={(event) => onSearchChange(event.target.value)}
        className="h-9 w-full min-w-0 sm:w-64"
      />

      {filters.map((filter) => (
        <div key={filter.key} className="grid gap-1 sm:flex sm:items-center">
          <label className="whitespace-nowrap text-xs text-muted-foreground">{filter.label}</label>
          <select
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
            className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm sm:w-auto"
          >
            {filter.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ))}

      {hasFilter && onReset && (
        <Button variant="ghost" size="sm" className="w-full sm:w-auto" onClick={onReset}>
          清除
        </Button>
      )}

      {(typeof total === 'number' || typeof filtered === 'number') && (
        <span className="text-xs text-muted-foreground sm:ml-auto">
          {typeof filtered === 'number' && typeof total === 'number'
            ? `${filtered} / ${total} 条`
            : typeof total === 'number'
              ? `${total} 条`
              : `${filtered} 条`}
        </span>
      )}
    </div>
  );
}

export function matchText(haystack: string | undefined | null, needle: string): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
