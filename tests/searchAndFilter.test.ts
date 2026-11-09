import { describe, it, expect } from 'vitest';
import {
  extractSearchableText,
  filterBottles,
  matchesQuery,
  searchAcrossCollections,
} from '../src/domain/searchAndFilter';
import { SAMPLE_BOTTLES } from '../src/data/sampleData';
import { createNewBottle } from '../src/domain/bottleUtils';

describe('searchAndFilter ドメインロジックテスト', () => {
  describe('extractSearchableText', () => {
    it('名前と主要属性が結合されて小文字で返されること', () => {
      const nihonshu = SAMPLE_BOTTLES.find((b) => b.category === '日本酒')!;
      const text = extractSearchableText(nihonshu);

      expect(text).toContain('純米大吟醸');
      expect(text).toContain('鳳凰');
      expect(text).toContain('鳳凰酒造'); // 蔵元
    });

    it('ワインの産地や品種が含まれること', () => {
      const wine = SAMPLE_BOTTLES.find((b) => b.category === 'ワイン')!;
      const text = extractSearchableText(wine);

      expect(text).toContain('ボルドー');
      expect(text).toContain('カベルネ');
    });

    it('ウイスキーの蒸留所が含まれること', () => {
      const whisky = SAMPLE_BOTTLES.find((b) => b.category === 'ウイスキー')!;
      const text = extractSearchableText(whisky);

      expect(text).toContain('グレンハイランド蒸留所');
    });
  });

  describe('matchesQuery', () => {
    it('空クエリは常に true を返すこと', () => {
      const bottle = SAMPLE_BOTTLES[0]!;
      expect(matchesQuery(bottle, '')).toBe(true);
      expect(matchesQuery(bottle, '   ')).toBe(true);
      expect(matchesQuery(bottle, undefined)).toBe(true);
    });

    it('名前に部分一致すること（大小文字無視）', () => {
      const wine = SAMPLE_BOTTLES.find((b) => b.name.includes('シャトー'))!;
      expect(matchesQuery(wine, 'シャトー')).toBe(true);
      expect(matchesQuery(wine, 'グラン')).toBe(true);
    });

    it('属性値（蔵元、蒸留所、産地、ボタニカル、スタイル等）に部分一致すること', () => {
      const beer = SAMPLE_BOTTLES.find((b) => b.category === 'ビール')!;
      expect(matchesQuery(beer, 'Hazy IPA')).toBe(true);
      expect(matchesQuery(beer, 'hazy')).toBe(true);
      expect(matchesQuery(beer, '志賀高原')).toBe(true);

      const gin = SAMPLE_BOTTLES.find((b) => b.category === 'ジン')!;
      expect(matchesQuery(gin, 'ジュニパーベリー')).toBe(true);
      expect(matchesQuery(gin, '柚子')).toBe(true);
    });

    it('複数語句の AND 検索ができること', () => {
      const wine = SAMPLE_BOTTLES.find((b) => b.category === 'ワイン')!;
      expect(matchesQuery(wine, 'ボルドー カベルネ')).toBe(true);
      expect(matchesQuery(wine, 'ボルドー 存在しない単語')).toBe(false);
    });
  });

  describe('filterBottles', () => {
    it('種類フィルタが正しく動作すること', () => {
      const sakes = filterBottles(SAMPLE_BOTTLES, { category: '日本酒' });
      expect(sakes.length).toBeGreaterThan(0);
      for (const b of sakes) {
        expect(b.category).toBe('日本酒');
      }

      const all = filterBottles(SAMPLE_BOTTLES, { category: 'all' });
      expect(all.length).toBe(SAMPLE_BOTTLES.length);
    });

    it('状態フィルタ (in_stock) で未開封と開封済みのみ抽出されること', () => {
      const inStock = filterBottles(SAMPLE_BOTTLES, { status: 'in_stock' });
      expect(inStock.length).toBeGreaterThan(0);
      for (const b of inStock) {
        expect(['unopened', 'opened']).toContain(b.status);
      }
    });

    it('状態フィルタ (個別) で正しく抽出されること', () => {
      const finished = filterBottles(SAMPLE_BOTTLES, { status: 'finished' });
      expect(finished.length).toBe(1);
      expect(finished[0]?.name).toBe('特別純米 初雪');

      const disposed = filterBottles(SAMPLE_BOTTLES, { status: 'disposed' });
      expect(disposed.length).toBe(1);
      expect(disposed[0]?.name).toBe('ヴィンテージ コニャック 1970');
    });

    it('論理削除レコードがデフォルトで除外されること', () => {
      const deletedBottle = createNewBottle({
        name: '削除済みボトル',
        category: '日本酒',
      });
      deletedBottle.deleted = true;

      const list = [...SAMPLE_BOTTLES, deletedBottle];
      const withoutDeleted = filterBottles(list);
      expect(withoutDeleted.some((b) => b.id === deletedBottle.id)).toBe(false);

      const withDeleted = filterBottles(list, { includeDeleted: true });
      expect(withDeleted.some((b) => b.id === deletedBottle.id)).toBe(true);
    });

    it('フィルタとキーワード検索を組み合わせて絞り込めること', () => {
      const result = filterBottles(SAMPLE_BOTTLES, {
        category: '日本酒',
        status: 'opened',
        query: '鳳凰',
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('純米大吟醸 鳳凰');
      expect(result[0]?.status).toBe('opened');
    });

    it('wantToBuyAgainOnly: true で「また買いたい」印のついたボトルのみ絞り込めること', () => {
      const allAgain = filterBottles(SAMPLE_BOTTLES, { wantToBuyAgainOnly: true });
      expect(allAgain.length).toBeGreaterThan(0);
      for (const b of allAgain) {
        expect(b.wantToBuyAgain).toBe(true);
      }

      // 飲んだ記録（finished）の中で「また買いたい」絞り込み
      const finishedAgain = filterBottles(SAMPLE_BOTTLES, {
        status: 'finished',
        wantToBuyAgainOnly: true,
      });
      for (const b of finishedAgain) {
        expect(b.status).toBe('finished');
        expect(b.wantToBuyAgain).toBe(true);
      }

      // 該当なし条件（存在しない種類と「また買いたい」の組み合わせ）
      const noneAgain = filterBottles(SAMPLE_BOTTLES, {
        category: 'シェリー',
        wantToBuyAgainOnly: true,
      });
      // SAMPLE_BOTTLES にシェリーで wantToBuyAgain === true のものがあるか確認し、ない場合は 0 件
      const expectedSherryAgain = SAMPLE_BOTTLES.filter((b) => b.category === 'シェリー' && b.wantToBuyAgain);
      expect(noneAgain).toHaveLength(expectedSherryAgain.length);
    });
  });

  describe('searchAcrossCollections (横断検索)', () => {
    it('検索クエリが家にある酒と飲んだ記録の両方に及ぶこと', () => {
      // '純米' で検索すると、家にある酒（純米大吟醸 鳳凰）と飲んだ記録（特別純米 初雪）の両方がヒット
      const result = searchAcrossCollections(SAMPLE_BOTTLES, '純米');

      expect(result.inStockBottles.length).toBeGreaterThan(0);
      expect(result.finishedBottles.length).toBeGreaterThan(0);

      expect(result.inStockBottles.some((b) => b.name === '純米大吟醸 鳳凰')).toBe(true);
      expect(result.finishedBottles.some((b) => b.name === '特別純米 初雪')).toBe(true);
    });
  });
});
