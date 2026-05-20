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
  /** 总数 / 筛选后剩余数 (可选,显示在右侧) */
  total?: number;
  filtered?: number;
  /** 一键清除 */
  onReset?: () => void;
  className?: string;
}

/**
 * 通用搜索 + 筛选栏。客户端过滤,数据量大时再升级到后端筛选。
 * 设计:
 *   - 左侧搜索框(input,实时过滤)
 *   - 多个状态 select(label + select)
 *   - 右侧:"X / Y 条"统计 + 清除按钮
 */
export function SearchFilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = '搜索…',
  filters = [],
  total,
  filtered,
  onReset,
  className,
}: SearchFilterBarProps) {
  const hasFilter =
    !!searchValue || filters.some((f) => f.value !== '');

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Input
        placeholder={searchPlaceholder}
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        className="h-9 w-64"
      />

      {filters.map((f) => (
        <div key={f.key} className="flex items-center gap-1">
          <label className="text-xs text-muted-foreground">{f.label}</label>
          <select
            value={f.value}
            onChange={(e) => f.onChange(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ))}

      {hasFilter && onReset && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          清除
        </Button>
      )}

      {(typeof total === 'number' || typeof filtered === 'number') && (
        <span className="ml-auto text-xs text-muted-foreground">
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

/** 给文本做大小写不敏感包含匹配 */
export function matchText(haystack: string | undefined | null, needle: string): boolean {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
