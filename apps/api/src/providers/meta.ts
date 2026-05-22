/**
 * MetaProvider: 实现 @ads/shared 的 AdsProvider 接口。
 * MVP 约束:
 *   - campaign copy 仅同账户(targetAdAccountId 缺省或 === adAccountId)
 *   - adset copy 仅同账户内目标 campaign;ad copy 仅同账户内目标 adset
 *   - remove 默认软删(ARCHIVED), hard=true 走 DELETE
 */
import type {
  AdsProvider,
  SetStatusInput,
  SetBudgetInput,
  CopyInput,
  DeleteInput,
} from '@ads/shared';
import { meta } from '../lib/meta-client';
import { HttpError } from '../lib/http-error';

export const metaProvider: AdsProvider = {
  name: 'meta',

  async setStatus(token, input: SetStatusInput): Promise<void> {
    const status =
      input.status === 'DELETED' ? 'ARCHIVED' : (input.status as 'ACTIVE' | 'PAUSED' | 'ARCHIVED');
    switch (input.targetType) {
      case 'campaign':
        return meta.setCampaignStatus(token, input.targetId, status);
      case 'adset':
        return meta.setAdSetStatus(token, input.targetId, status);
      case 'ad':
        return meta.setAdStatus(token, input.targetId, status);
    }
  },

  async setBudget(token, input: SetBudgetInput): Promise<void> {
    const b: { daily?: number; lifetime?: number } = {};
    if (input.dailyBudget !== undefined) b.daily = input.dailyBudget;
    if (input.lifetimeBudget !== undefined) b.lifetime = input.lifetimeBudget;
    await meta.setBudget(token, input.targetId, b);
  },

  async copy(token, input: CopyInput): Promise<{ newId: string }> {
    switch (input.targetType) {
      case 'campaign': {
        if (input.targetAdAccountId && input.targetAdAccountId !== input.adAccountId) {
          throw new HttpError(422, 422, 'MVP 仅支持同账户复制');
        }
        const r = await meta.customCopyCampaign(token, input.adAccountId, input.sourceId, {
          deepCopy: input.deepCopy ?? true,
          ...(input.targetAdAccountId ? { targetAdAccountId: input.targetAdAccountId } : {}),
          ...(input.startTime ? { startTime: input.startTime } : {}),
          ...(input.endTime ? { endTime: input.endTime } : {}),
          ...(input.statusOption ? { statusOption: input.statusOption } : {}),
          ...(input.renameOptions ? { renameOptions: input.renameOptions } : {}),
        });
        return { newId: r.newCampaignId };
      }
      case 'adset': {
        const r = await meta.customCopyAdSet(token, input.adAccountId, input.sourceId, {
          deepCopy: input.deepCopy ?? true,
          ...(input.targetCampaignId ? { targetCampaignId: input.targetCampaignId } : {}),
          ...(input.startTime ? { startTime: input.startTime } : {}),
          ...(input.endTime ? { endTime: input.endTime } : {}),
          ...(input.statusOption ? { statusOption: input.statusOption } : {}),
          ...(input.renameOptions ? { renameOptions: input.renameOptions } : {}),
        });
        return { newId: r.newAdSetId };
      }
      case 'ad': {
        const r = await meta.customCopyAd(token, input.adAccountId, input.sourceId, {
          ...(input.targetAdSetId ? { targetAdSetId: input.targetAdSetId } : {}),
          ...(input.statusOption ? { statusOption: input.statusOption } : {}),
          ...(input.renameOptions ? { renameOptions: input.renameOptions } : {}),
        });
        return { newId: r.newAdId };
      }
    }
  },

  async remove(token, input: DeleteInput): Promise<void> {
    const hard = input.hard === true;
    switch (input.targetType) {
      case 'campaign':
        return meta.removeCampaign(token, input.targetId, { hard });
      case 'adset':
        return meta.removeAdSet(token, input.targetId, { hard });
      case 'ad':
        return meta.removeAd(token, input.targetId, { hard });
    }
  },
};
