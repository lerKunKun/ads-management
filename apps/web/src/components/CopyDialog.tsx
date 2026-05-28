import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import type { CopyParams } from '@/lib/api';

interface CopyDialogProps {
  open: boolean;
  layer: 'campaign' | 'adset' | 'ad';
  /** 显示给用户的源对象数(单选 1,批量 N) */
  targetCount: number;
  /** 单选时显示源名;批量时显示数字 */
  hint?: string;
  onCancel: () => void;
  onSubmit: (params: CopyParams) => void;
  submitting: boolean;
}

/**
 * 复制对话框 - 支持:
 *   复制条数 N(默认 1, 不设上限)
 *   自定义前缀
 *   日期后缀(可选,自动 yyyymmdd)
 *   国家后缀(自由输入)
 *   测试编号后缀(数字 padded 2 位,从 #1 开始 — N>1 时 worker 自动追加)
 */
export function CopyDialog({
  open,
  layer,
  targetCount,
  hint,
  onCancel,
  onSubmit,
  submitting,
}: CopyDialogProps) {
  const [count, setCount] = useState(1);
  const [prefix, setPrefix] = useState('');
  const [dateSuffix, setDateSuffix] = useState(false);
  const [country, setCountry] = useState('');
  const [testIdx, setTestIdx] = useState('');
  const [deepCopy, setDeepCopy] = useState(true);
  const [pauseAfter, setPauseAfter] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCount(1);
    setPrefix('');
    setDateSuffix(false);
    setCountry('');
    setTestIdx('');
    setDeepCopy(true);
    setPauseAfter(false);
  }, [open]);

  function buildSuffix(): string {
    const parts: string[] = [];
    if (dateSuffix) parts.push(formatYMD(new Date()));
    if (country) parts.push(country.toUpperCase());
    if (testIdx) parts.push(`T${testIdx}`);
    return parts.length ? '_' + parts.join('_') : '';
  }

  function handleSubmit() {
    if (!Number.isFinite(count) || count < 1) {
      alert('复制条数必须 ≥ 1');
      return;
    }
    const suffix = buildSuffix();
    const params: CopyParams = {
      count,
      statusOption: pauseAfter ? 'PAUSED' : 'INHERITED_FROM_SOURCE',
      ...(layer !== 'ad' ? { deepCopy } : {}),
      ...((prefix || suffix)
        ? {
          renameOptions: {
            rename_strategy: 'ONLY_TOP_LEVEL_RENAME',
            ...(prefix ? { rename_prefix: prefix } : {}),
            ...(suffix ? { rename_suffix: suffix } : {}),
          },
        }
        : {}),
    };
    onSubmit(params);
  }

  const layerName =
    layer === 'campaign' ? '广告系列' : layer === 'adset' ? '广告组' : '广告';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !submitting && onCancel()}
      title={`复制 ${layerName}${targetCount > 1 ? ` ×${targetCount}` : ''}`}
    >
      {hint && <p className="mb-2 break-words text-xs text-muted-foreground">{hint}</p>}

      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground">每个源复制 N 份</label>
          <Input
            type="number"
            min={1}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
          />
          {count > 1 && (
            <p className="text-xs text-muted-foreground mt-1">
              N 份会自动加 -01 / -02 / … 后缀,避免名字冲突。共产生{' '}
              <b>{targetCount * count}</b> 个新{layerName}。
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-sm text-muted-foreground">前缀</label>
            <Input
              placeholder="如 ABTest_"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground">国家后缀</label>
            <Input
              placeholder="US / SEA"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
              <input
                type="checkbox"
                checked={dateSuffix}
                onChange={(e) => setDateSuffix(e.target.checked)}
              />
              日期后缀 ({formatYMD(new Date())})
            </label>
          </div>
          <div>
            <label className="text-sm text-muted-foreground">测试编号</label>
            <Input
              placeholder="如 v1"
              value={testIdx}
              onChange={(e) => setTestIdx(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          {layer !== 'ad' && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deepCopy}
                onChange={(e) => setDeepCopy(e.target.checked)}
              />
              深复制（含下级）
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pauseAfter}
              onChange={(e) => setPauseAfter(e.target.checked)}
            />
            复制后保持暂停
          </label>
        </div>

        <div className="rounded-md bg-muted/50 p-2 text-xs">
          <span className="text-muted-foreground">预览名:</span>{' '}
          <span className="break-all font-mono">
            {prefix || ''}
            <span className="text-muted-foreground">{`{原${layerName}名}`}</span>
            {buildSuffix()}
            {count > 1 ? <span className="text-emerald-600">-01..-{String(count).padStart(2, '0')}</span> : ''}
          </span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          取消
        </Button>
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? '提交中…' : '开始复制'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function formatYMD(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
