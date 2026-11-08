import { describe, it, expect } from 'vitest';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../src/data/sampleData';
import { SAKE_CATEGORIES, BOTTLE_STATUSES, BottleRecord } from '../src/types/sake';
import { CATEGORY_ORDER, isSakeCategory, CATEGORY_ATTRIBUTE_LABELS } from '../src/domain/categories';

describe('PR #1 検証環境セットアップテスト', () => {
  it('固定10種類が定義されており判定ガードが正しく動作すること', () => {
    expect(SAKE_CATEGORIES).toHaveLength(10);
    expect(isSakeCategory('日本酒')).toBe(true);
    expect(isSakeCategory('ワイン')).toBe(true);
    expect(isSakeCategory('未知のお酒')).toBe(false);
  });

  it('固定種類の順序マップが0〜9で定義されていること', () => {
    expect(CATEGORY_ORDER['日本酒']).toBe(0);
    expect(CATEGORY_ORDER['ワイン']).toBe(1);
    expect(CATEGORY_ORDER['その他']).toBe(9);
  });

  it('サンプルデータに固定4状態と固定10種類がすべて含まれていること', () => {
    const statuses = new Set(SAMPLE_BOTTLES.map((b) => b.status));
    for (const status of BOTTLE_STATUSES) {
      expect(statuses.has(status)).toBe(true);
    }

    const categories = new Set(SAMPLE_BOTTLES.map((b) => b.category));
    for (const cat of SAKE_CATEGORIES) {
      expect(categories.has(cat)).toBe(true);
    }
  });

  it('サンプルボトルの購入価格と相場目安が構造上完全に分離されていること', () => {
    for (const bottle of SAMPLE_BOTTLES) {
      expect(bottle).toHaveProperty('purchaseInfo');
      expect(bottle.purchaseInfo).toHaveProperty('purchasePriceYen');
      if (bottle.referencePrice !== null) {
        expect(bottle.referencePrice).toHaveProperty('estimatedPriceYen');
        // purchasePriceYen と estimatedPriceYen は別オブジェクト・別プロパティである
        expect(Object.is(bottle.purchaseInfo, bottle.referencePrice)).toBe(false);
      }
    }
  });

  it('サンプル写真の全枚数が紐付け可能で双方向参照整合性を満たすこと', () => {
    expect(SAMPLE_PHOTOS.length).toBeGreaterThan(0);
    const photoMap = new Map(SAMPLE_PHOTOS.map((p) => [p.id, p]));
    const bottleMap = new Map(SAMPLE_BOTTLES.map((b) => [b.id, b]));

    // 写真側から親ボトルへの検証
    for (const photo of SAMPLE_PHOTOS) {
      expect(photo.dataUrl.startsWith(`data:${photo.mimeType};base64,`)).toBe(true);
      const parentBottle = bottleMap.get(photo.bottleId);
      expect(parentBottle).toBeDefined();
      expect(parentBottle?.photoIds).toContain(photo.id);
    }

    // ボトル側から写真への検証
    for (const bottle of SAMPLE_BOTTLES) {
      for (const id of bottle.photoIds) {
        expect(photoMap.has(id)).toBe(true);
      }
      if (bottle.primaryPhotoId !== null) {
        expect(bottle.photoIds).toContain(bottle.primaryPhotoId);
      }
    }
  });

  it('BottleRecord が種類別属性と正しく連動すること', () => {
    for (const bottle of SAMPLE_BOTTLES) {
      const allowedAttrs = CATEGORY_ATTRIBUTE_LABELS[bottle.category];
      for (const key of Object.keys(bottle.categoryAttributes)) {
        expect(key in allowedAttrs).toBe(true);
      }
    }

    // Discriminated Union 型の動作確認
    const nihonshu: BottleRecord<'日本酒'> = SAMPLE_BOTTLES[0] as BottleRecord<'日本酒'>;
    expect(nihonshu.category).toBe('日本酒');
    expect(nihonshu.categoryAttributes.brewery).toBe('鳳凰酒造');
  });
});
