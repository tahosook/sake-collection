import { describe, it, expect } from 'vitest';
import {
  calculateOpenedDays,
  createNewBottle,
  getTodayDateString,
  transitionBottleStatus,
} from '../src/domain/bottleUtils';
import { SAMPLE_BOTTLES } from '../src/data/sampleData';

describe('bottleUtils ドメインロジックテスト', () => {
  describe('calculateOpenedDays', () => {
    it('opened かつ openedDate がある場合、経過日数を正しく算出すること', () => {
      const openedBottle = SAMPLE_BOTTLES.find((b) => b.status === 'opened' && b.openedDate !== null)!;
      expect(openedBottle).toBeDefined();

      // 開封日: 2026-10-25、基準日: 2026-11-08 -> 14日差
      const days = calculateOpenedDays(openedBottle, '2026-11-08');
      expect(days).toBe(14);

      // 当日開封の場合 -> 0日
      const sameDay = calculateOpenedDays(openedBottle, '2026-10-25');
      expect(sameDay).toBe(0);

      // 翌日開封の場合 -> 1日
      const nextDay = calculateOpenedDays(openedBottle, '2026-10-26');
      expect(nextDay).toBe(1);
    });

    it('opened でも openedDate が null の場合は null を返すこと', () => {
      const bottle = createNewBottle({
        name: '開封日未入力ボトル',
        category: 'ウイスキー',
        status: 'opened',
        openedDate: null,
      });

      expect(calculateOpenedDays(bottle)).toBeNull();
    });

    it('unopened, finished, disposed の場合は openedDate があっても null を返すこと', () => {
      // 未開封
      const unopened = SAMPLE_BOTTLES.find((b) => b.status === 'unopened')!;
      expect(calculateOpenedDays(unopened)).toBeNull();

      // 飲み切り
      const finished = SAMPLE_BOTTLES.find((b) => b.status === 'finished')!;
      expect(finished.openedDate).not.toBeNull();
      expect(calculateOpenedDays(finished)).toBeNull();

      // 手放した
      const disposed = SAMPLE_BOTTLES.find((b) => b.status === 'disposed')!;
      expect(calculateOpenedDays(disposed)).toBeNull();
    });

    it('未来の日付が入っている場合は 0 を返すこと', () => {
      const bottle = createNewBottle({
        name: '未来開封日ボトル',
        category: '日本酒',
        status: 'opened',
        openedDate: '2026-12-01',
      });

      expect(calculateOpenedDays(bottle, '2026-11-08')).toBe(0);
    });
  });

  describe('transitionBottleStatus', () => {
    const original = SAMPLE_BOTTLES.find((b) => b.name === '純米大吟醸 鳳凰' && b.status === 'opened')!;

    it('unopened に変更したとき、全ての日付が null にクリアされること（取り消し）', () => {
      const transitioned = transitionBottleStatus(original, 'unopened', {
        nowIso: '2026-11-08T12:00:00.000Z',
      });

      expect(transitioned.status).toBe('unopened');
      expect(transitioned.openedDate).toBeNull();
      expect(transitioned.finishedDate).toBeNull();
      expect(transitioned.disposedDate).toBeNull();
      expect(transitioned.updatedAt).toBe('2026-11-08T12:00:00.000Z');
      // イミュータブルであること
      expect(original.status).toBe('opened');
    });

    it('opened に変更したとき、openedDate が設定され不要日付が null になること', () => {
      const unopened = SAMPLE_BOTTLES.find((b) => b.status === 'unopened')!;
      const transitioned = transitionBottleStatus(unopened, 'opened', {
        dateOverride: '2026-11-01',
      });

      expect(transitioned.status).toBe('opened');
      expect(transitioned.openedDate).toBe('2026-11-01');
      expect(transitioned.finishedDate).toBeNull();
      expect(transitioned.disposedDate).toBeNull();
    });

    it('finished に変更したとき、finishedDate が自動設定され disposedDate が null になること', () => {
      const transitioned = transitionBottleStatus(original, 'finished', {
        dateOverride: '2026-11-08',
      });

      expect(transitioned.status).toBe('finished');
      expect(transitioned.openedDate).toBe(original.openedDate); // 開封日は維持
      expect(transitioned.finishedDate).toBe('2026-11-08');
      expect(transitioned.disposedDate).toBeNull();
    });

    it('disposed に変更したとき、disposedDate が自動設定され finishedDate が null になること', () => {
      const transitioned = transitionBottleStatus(original, 'disposed', {
        dateOverride: '2026-11-08',
      });

      expect(transitioned.status).toBe('disposed');
      expect(transitioned.disposedDate).toBe('2026-11-08');
      expect(transitioned.finishedDate).toBeNull();
    });
  });

  describe('createNewBottle', () => {
    it('デフォルトで未開封(unopened)かつ日付がすべてnullのボトルを生成すること', () => {
      const bottle = createNewBottle({
        name: '手入力テスト酒',
        category: '日本酒',
        volumeMl: 720,
        abv: 15.0,
      });

      expect(bottle.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(bottle.status).toBe('unopened');
      expect(bottle.openedDate).toBeNull();
      expect(bottle.finishedDate).toBeNull();
      expect(bottle.disposedDate).toBeNull();
      expect(bottle.deleted).toBe(false);
      expect(bottle.purchaseInfo.purchasePlace).toBe('');
      expect(bottle.purchaseInfo.purchasePriceYen).toBeNull();
      expect(bottle.referencePrice).toBeNull();
    });

    it('登録時から開封済みを選択した場合、openedDate が設定可能で不要日付が null になること', () => {
      const bottle = createNewBottle({
        name: '最初から開封済み酒',
        category: 'ウイスキー',
        status: 'opened',
        openedDate: '2026-10-01',
      });

      expect(bottle.status).toBe('opened');
      expect(bottle.openedDate).toBe('2026-10-01');
      expect(bottle.finishedDate).toBeNull();
      expect(bottle.disposedDate).toBeNull();
    });
  });

  describe('getTodayDateString', () => {
    it('YYYY-MM-DD 形式の日付文字列を返すこと', () => {
      const date = new Date(2026, 9, 25); // 2026-10-25
      expect(getTodayDateString(date)).toBe('2026-10-25');
    });
  });
});
