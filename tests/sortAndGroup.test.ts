import { describe, it, expect } from 'vitest';
import {
  compareBottles,
  compareGroups,
  generateGroupKey,
  getEffectivePurchaseDate,
  groupBottlesForDisplay,
  normalizeSakeName,
} from '../src/domain/sortAndGroup';
import { SAMPLE_BOTTLES } from '../src/data/sampleData';
import { WineAttributes } from '../src/types/sake';
import { createNewBottle } from '../src/domain/bottleUtils';

describe('sortAndGroup ドメインロジックテスト', () => {
  describe('normalizeSakeName', () => {
    it('前後の空白を除去し、連続する空白を半角スペース1つに正規化すること', () => {
      expect(normalizeSakeName('  純米大吟醸   鳳凰  ')).toBe('純米大吟醸 鳳凰');
      expect(normalizeSakeName('\tChateau   Margaux\n')).toBe('Chateau Margaux');
    });
  });

  describe('getEffectivePurchaseDate', () => {
    it('purchaseDate が存在する場合はそれを返すこと', () => {
      const bottle = SAMPLE_BOTTLES.find((b) => b.purchaseInfo.purchaseDate !== null)!;
      expect(getEffectivePurchaseDate(bottle)).toBe(bottle.purchaseInfo.purchaseDate);
    });

    it('purchaseDate が null の場合は createdAt の YYYY-MM-DD 部分で代用すること', () => {
      const bottle = SAMPLE_BOTTLES.find((b) => b.purchaseInfo.purchaseDate === null)!;
      expect(bottle).toBeDefined();
      expect(getEffectivePurchaseDate(bottle)).toBe(bottle.createdAt.slice(0, 10));
    });
  });

  describe('generateGroupKey', () => {
    it('名前・種類・容量から一意なグループキーを生成すること', () => {
      const b1 = SAMPLE_BOTTLES.find((b) => b.name === '純米大吟醸 鳳凰' && b.status === 'opened')!;
      const b2 = SAMPLE_BOTTLES.find((b) => b.name === '純米大吟醸 鳳凰' && b.status === 'unopened')!;
      expect(generateGroupKey(b1)).toBe(generateGroupKey(b2));
      expect(generateGroupKey(b1)).toBe('日本酒::純米大吟醸 鳳凰::720ml::');
    });

    it('ワインの場合はヴィンテージ年を含め、年違いで別キーになること', () => {
      const w2018 = SAMPLE_BOTTLES.find(
        (b) => b.name === 'シャトー・グラン・レゼルヴ' &&
        (b.categoryAttributes as WineAttributes).vintageYear === 2018
      )!;
      const w2019 = SAMPLE_BOTTLES.find(
        (b) => b.name === 'シャトー・グラン・レゼルヴ' &&
        (b.categoryAttributes as WineAttributes).vintageYear === 2019
      )!;
      expect(w2018).toBeDefined();
      expect(w2019).toBeDefined();
      expect(generateGroupKey(w2018)).toBe('ワイン::シャトー・グラン・レゼルヴ::750ml::2018');
      expect(generateGroupKey(w2019)).toBe('ワイン::シャトー・グラン・レゼルヴ::750ml::2019');
      expect(generateGroupKey(w2018)).not.toBe(generateGroupKey(w2019));
    });
  });

  describe('compareBottles (1本単位の並び順)', () => {
    it('1. 状態優先度: opened（開封済み）が unopened（未開封）より先に来ること', () => {
      const opened = createNewBottle({
        name: '銘柄A',
        category: '日本酒',
        status: 'opened',
        openedDate: '2026-10-01',
        purchaseInfo: { purchaseDate: '2026-09-01' },
      });
      const unopened = createNewBottle({
        name: '銘柄A',
        category: '日本酒',
        status: 'unopened',
        purchaseInfo: { purchaseDate: '2026-11-01' }, // 購入日は新しいが未開封
      });

      expect(compareBottles(opened, unopened)).toBeLessThan(0);
      expect(compareBottles(unopened, opened)).toBeGreaterThan(0);
    });

    it('2. 種類順: SAKE_CATEGORIES の記載順（日本酒 → ワイン → ウイスキー...）に従うこと', () => {
      const sake = createNewBottle({ name: '酒', category: '日本酒', status: 'unopened' });
      const wine = createNewBottle({ name: '酒', category: 'ワイン', status: 'unopened' });
      const whisky = createNewBottle({ name: '酒', category: 'ウイスキー', status: 'unopened' });

      expect(compareBottles(sake, wine)).toBeLessThan(0);
      expect(compareBottles(wine, whisky)).toBeLessThan(0);
      expect(compareBottles(whisky, sake)).toBeGreaterThan(0);
    });

    it('3. 有効購入日: 新しい日付が上（降順）に来ること', () => {
      const older = createNewBottle({
        name: '酒',
        category: '日本酒',
        status: 'unopened',
        purchaseInfo: { purchaseDate: '2026-01-01' },
      });
      const newer = createNewBottle({
        name: '酒',
        category: '日本酒',
        status: 'unopened',
        purchaseInfo: { purchaseDate: '2026-05-01' },
      });

      expect(compareBottles(newer, older)).toBeLessThan(0);
      expect(compareBottles(older, newer)).toBeGreaterThan(0);
    });

    it('4. 購入日未入力の場合、登録日(createdAt)の日付で代用されること', () => {
      const b1 = createNewBottle(
        { name: '酒', category: '日本酒', status: 'unopened', purchaseInfo: { purchaseDate: null } },
        { nowIso: '2026-10-20T12:00:00.000Z' }
      );
      const b2 = createNewBottle(
        { name: '酒', category: '日本酒', status: 'unopened', purchaseInfo: { purchaseDate: '2026-10-10' } }
      );

      // b1の代用有効購入日 (2026-10-20) > b2の購入日 (2026-10-10) なので b1 が先
      expect(compareBottles(b1, b2)).toBeLessThan(0);
    });

    it('5. タイブレーク: createdAt 降順 → id 辞書順で安定ソートされること', () => {
      const b1 = createNewBottle(
        { name: '酒', category: '日本酒', status: 'unopened', purchaseInfo: { purchaseDate: '2026-10-01' } },
        { nowIso: '2026-10-01T12:00:00.000Z', id: '11111111-1111-4000-8000-000000000001' }
      );
      const b2 = createNewBottle(
        { name: '酒', category: '日本酒', status: 'unopened', purchaseInfo: { purchaseDate: '2026-10-01' } },
        { nowIso: '2026-10-01T10:00:00.000Z', id: '22222222-2222-4000-8000-000000000002' }
      );

      // b1 の方が createdAt が新しいので先
      expect(compareBottles(b1, b2)).toBeLessThan(0);
    });
  });

  describe('groupBottlesForDisplay (まとめ表示とグループ化)', () => {
    it('同一銘柄（名前＋種類＋容量一致）が1つのグループにまとまること', () => {
      const groups = groupBottlesForDisplay(SAMPLE_BOTTLES);
      const hououGroup = groups.find((g) => g.name === '純米大吟醸 鳳凰');

      expect(hououGroup).toBeDefined();
      expect(hououGroup?.count).toBe(2);
      expect(hououGroup?.bottles).toHaveLength(2);
      // グループ内ソートで opened が先頭
      expect(hououGroup?.bottles[0]?.status).toBe('opened');
      expect(hououGroup?.bottles[1]?.status).toBe('unopened');
      expect(hououGroup?.priorityStatus).toBe('opened');
    });

    it('ワインのヴィンテージ違いが別グループになること', () => {
      const groups = groupBottlesForDisplay(SAMPLE_BOTTLES);
      const wineGroups = groups.filter((g) => g.name === 'シャトー・グラン・レゼルヴ');

      expect(wineGroups).toHaveLength(2);
      const years = wineGroups.map((g) => g.vintageYear).sort();
      expect(years).toEqual([2018, 2019]);
    });

    it('飲み切り(finished)や手放した(disposed)は一覧グループ化から除外されること', () => {
      const groups = groupBottlesForDisplay(SAMPLE_BOTTLES);
      const allBottlesInGroups = groups.flatMap((g) => g.bottles);

      for (const b of allBottlesInGroups) {
        expect(['unopened', 'opened']).toContain(b.status);
        expect(b.deleted).toBe(false);
      }

      // サンプル内の finished（初雪）や disposed（コニャック1970）が含まれていないこと
      expect(allBottlesInGroups.some((b) => b.name === '特別純米 初雪')).toBe(false);
      expect(allBottlesInGroups.some((b) => b.name === 'ヴィンテージ コニャック 1970')).toBe(false);
    });

    it('グループ代表写真が適切に選定されること', () => {
      const groups = groupBottlesForDisplay(SAMPLE_BOTTLES);
      const hououGroup = groups.find((g) => g.name === '純米大吟醸 鳳凰')!;
      expect(hououGroup.primaryPhotoId).toBe('11111111-0001-4000-8000-000000000001');
    });

    it('グループ間の並び順が開封済み優先 → 種類記載順 → 最新購入日順になること', () => {
      const groups = groupBottlesForDisplay(SAMPLE_BOTTLES);

      for (let i = 0; i < groups.length - 1; i++) {
        const current = groups[i]!;
        const next = groups[i + 1]!;
        expect(compareGroups(current, next)).toBeLessThanOrEqual(0);
      }
    });

    it('絞り込み後の配列を渡した場合、本数(count)は絞り込み後の数になること', () => {
      // 鳳凰のうち未開封のみに絞り込んだ場合
      const filtered = SAMPLE_BOTTLES.filter((b) => b.name === '純米大吟醸 鳳凰' && b.status === 'unopened');
      const groups = groupBottlesForDisplay(filtered);

      expect(groups).toHaveLength(1);
      expect(groups[0]?.count).toBe(1);
      expect(groups[0]?.priorityStatus).toBe('unopened');
    });
  });
});
