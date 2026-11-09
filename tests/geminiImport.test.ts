import { describe, it, expect } from 'vitest';
import {
  CATEGORY_DESCRIPTION_AXES,
  buildGeminiConsultationPrompt,
  parseAndValidateGeminiJson,
  mergeGeminiPayloadIntoBottle,
  GeminiImportPayload,
} from '../src/domain/geminiPrompt';
import {
  findDuplicateBottles,
  createReuseDraftFromBottle,
  createBottlesBatch,
  createNewBottle,
  CreateBottleInput,
} from '../src/domain/bottleUtils';
import { SAKE_CATEGORIES } from '../src/types/sake';
import { SAMPLE_BOTTLES } from '../src/data/sampleData';

describe('Gemini 相談・取り込み・ドメインロジックテスト (PR #6)', () => {
  describe('CATEGORY_DESCRIPTION_AXES & buildGeminiConsultationPrompt', () => {
    it('固定10種類すべての解説軸が漏れなく定義されていること', () => {
      for (const cat of SAKE_CATEGORIES) {
        const axes = CATEGORY_DESCRIPTION_AXES[cat];
        expect(axes).toBeDefined();
        expect(axes.tasteAxis.length).toBeGreaterThan(0);
        expect(axes.backgroundAxis.length).toBeGreaterThan(0);
        expect(axes.servingAxis.length).toBeGreaterThan(0);
      }
    });

    it('相談用プロンプトに正確さの原則、固定10種、4部構成、相場目安の指示が含まれること', () => {
      const prompt = buildGeminiConsultationPrompt({
        categoryHint: '日本酒',
        todayDate: '2026-11-09',
      });

      expect(prompt).toContain('【厳守する正確さの原則】');
      expect(prompt).toContain('確実に裏付けが取れた事実のみ');
      expect(prompt).toContain('「不明」と明記');
      expect(prompt).toContain('宣伝文句や誇張は禁止');
      expect(prompt).toContain('300〜500字を目安');
      expect(prompt).toContain('日本円のみ');
      expect(prompt).toContain('容量（volumeMl）が異なる商品の相場は絶対に混ぜない');
      expect(prompt).toContain('お酒の種類ヒント: 「日本酒」');
      expect(prompt).toContain('2026-11-09');
    });
  });

  describe('parseAndValidateGeminiJson', () => {
    const validJsonText = `
\`\`\`json
{
  "name": "純米大吟醸 鳳凰",
  "category": "日本酒",
  "abv": 16.0,
  "volumeMl": 720,
  "categoryAttributes": {
    "brewery": "鳳凰酒造",
    "ricePolishingRatio": "45%",
    "specificName": "純米大吟醸"
  },
  "description": {
    "summary": "山田錦を極限まで磨いた純米大吟醸。",
    "tasteProfile": "洋梨のような華やかな香りと透明感のある旨味。",
    "background": "伝統蔵が契約栽培米のみで醸す限定酒。",
    "servingSuggestion": "冷酒でワイングラスがおすすめ。"
  },
  "sources": [
    {
      "title": "公式サイト",
      "url": "https://example.com/houou"
    }
  ],
  "referencePrice": {
    "estimatedPriceYen": 3500,
    "fetchedDate": "2026-11-09",
    "note": "720ml 税込希望小売価格"
  }
}
\`\`\`
`;

    it('有効な Markdown コードブロック付き JSON を正しく抽出・パースできること', () => {
      const res = parseAndValidateGeminiJson(validJsonText);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.name).toBe('純米大吟醸 鳳凰');
        expect(res.data.category).toBe('日本酒');
        expect(res.data.abv).toBe(16.0);
        expect(res.data.volumeMl).toBe(720);
        expect(res.data.categoryAttributes['brewery']).toBe('鳳凰酒造');
        expect(res.data.description?.summary).toContain('純米大吟醸');
        expect(res.data.sources[0]?.url).toBe('https://example.com/houou');
        expect(res.data.referencePrice?.estimatedPriceYen).toBe(3500);
        expect(res.data.referencePrice?.fetchedDate).toBe('2026-11-09');
        expect(res.warnings).toHaveLength(0);
      }
    });

    it('前後に挨拶文があるテキストから JSON オブジェクト部分を抽出できること', () => {
      const textWithGreeting = `こんにちは！お酒の情報を抽出しました。\n{"name":"テスト酒","category":"ウイスキー"}\nご確認ください！`;
      const res = parseAndValidateGeminiJson(textWithGreeting);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.name).toBe('テスト酒');
        expect(res.data.category).toBe('ウイスキー');
      }
    });

    it('壊れた JSON 文字列はエラーとなり弾かれること', () => {
      const broken = '```json\n{ "name": "壊れたお酒", category: 不正なJSON\n```';
      const res = parseAndValidateGeminiJson(broken);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors[0]).toContain('JSONの形式が正しくありません');
      }
    });

    it('必須項目 name が欠落または空欄の場合はエラーとなること', () => {
      const noName = JSON.stringify({ category: '日本酒', abv: 15 });
      const res = parseAndValidateGeminiJson(noName);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.includes('名前（銘柄名）'))).toBe(true);
      }
    });

    it('未知の種類（固定10種以外）の場合はエラーとなること', () => {
      const unknownCat = JSON.stringify({ name: 'テキーラサンライズ', category: 'テキーラ' });
      const res = parseAndValidateGeminiJson(unknownCat);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.includes('種類「テキーラ」は未対応です'))).toBe(true);
      }
    });

    it('度数や容量が不正な数値（範囲外・負数）の場合はエラーとなること', () => {
      const invalidNumbers = JSON.stringify({
        name: '不正数値酒',
        category: '焼酎',
        abv: 120, // 100超
        volumeMl: -500, // 負数
      });
      const res = parseAndValidateGeminiJson(invalidNumbers);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.includes('度数（abv）'))).toBe(true);
        expect(res.errors.some((e) => e.includes('容量（volumeMl）'))).toBe(true);
      }
    });

    it('度数・容量・相場目安に文字列や真偽値など数値型以外が渡された場合は暗黙変換せずエラーとなること', () => {
      const stringNumbers = JSON.stringify({
        name: '文字列数値酒',
        category: '日本酒',
        abv: "15.0", // 文字列
        volumeMl: "720", // 文字列
        referencePrice: {
          estimatedPriceYen: true, // 真偽値
        },
      });
      const res = parseAndValidateGeminiJson(stringNumbers);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.errors.some((e) => e.includes('度数（abv）は 0〜100 の数値または null'))).toBe(true);
        expect(res.errors.some((e) => e.includes('容量（volumeMl）は正の数値または null'))).toBe(true);
        expect(res.errors.some((e) => e.includes('相場目安（estimatedPriceYen）は 0 以上の数値または null'))).toBe(true);
      }
    });

    it('種類に未定義の属性キーは除外され警告が出ること', () => {
      const unknownAttrs = JSON.stringify({
        name: '純米酒',
        category: '日本酒',
        categoryAttributes: {
          brewery: '山田蔵',
          distillery: '蒸留所キーは日本酒には存在しない',
        },
      });
      const res = parseAndValidateGeminiJson(unknownAttrs);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.categoryAttributes['brewery']).toBe('山田蔵');
        expect(res.data.categoryAttributes['distillery']).toBeUndefined();
        expect(res.warnings.some((w) => w.includes('未定義の属性キー'))).toBe(true);
      }
    });

    it('不正な出典URLは除外され警告が出ること', () => {
      const invalidSources = JSON.stringify({
        name: 'ワイン',
        category: 'ワイン',
        sources: [
          { url: 'https://valid.com' },
          { url: 'not-a-valid-url' },
        ],
      });
      const res = parseAndValidateGeminiJson(invalidSources);
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.sources).toHaveLength(1);
        expect(res.data.sources[0]?.url).toBe('https://valid.com');
        expect(res.warnings.some((w) => w.includes('不正な形式の出典URL'))).toBe(true);
      }
    });

    it('相場目安の取得日がない場合は当日の日付で補完され警告が出ること', () => {
      const noFetchedDate = JSON.stringify({
        name: 'ウイスキー',
        category: 'ウイスキー',
        referencePrice: {
          estimatedPriceYen: 5000,
        },
      });
      const res = parseAndValidateGeminiJson(noFetchedDate, { todayDate: '2026-11-09' });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.referencePrice?.estimatedPriceYen).toBe(5000);
        expect(res.data.referencePrice?.fetchedDate).toBe('2026-11-09');
        expect(res.warnings.some((w) => w.includes('相場目安の取得日を本日の日付'))).toBe(true);
      }
    });
  });

  describe('mergeGeminiPayloadIntoBottle (userEditedFields 上書き防止)', () => {
    const existingBottle = createNewBottle({
      name: 'ユーザー編集した銘柄名',
      category: '日本酒',
      abv: 15.5,
      volumeMl: 720,
      categoryAttributes: {
        brewery: 'ユーザー指定の蔵元',
        specificName: '純米大吟醸',
      },
      purchaseInfo: {
        purchaseDate: '2026-10-01',
        purchasePlace: '地元の酒屋',
        purchasePriceYen: 3200,
      },
      description: {
        summary: 'ユーザーが書いた要約',
        tasteProfile: '',
        background: '',
        servingSuggestion: '',
      },
    });

    const geminiPayload: GeminiImportPayload = {
      name: 'AIが推定した銘柄名',
      category: '日本酒',
      abv: 16.0,
      volumeMl: 720,
      categoryAttributes: {
        brewery: 'AI推定蔵元',
        ricePolishingRatio: '50%',
        specificName: '純米吟醸',
      },
      description: {
        summary: 'AIが書いた要約',
        tasteProfile: '華やかな香り',
        background: '100年の歴史',
        servingSuggestion: '冷酒で',
      },
      sources: [{ url: 'https://ai-source.com' }],
      referencePrice: {
        estimatedPriceYen: 4000,
        fetchedDate: '2026-11-09',
      },
    };

    it('userEditedFields に指定された項目は上書きされず、未指定項目のみ更新されること', () => {
      // ユーザーが 'name', 'categoryAttributes.brewery', 'description.summary' を手編集したとする
      const userEditedFields = ['name', 'categoryAttributes.brewery', 'description.summary'];

      const { merged, skippedFields } = mergeGeminiPayloadIntoBottle(
        existingBottle,
        geminiPayload,
        userEditedFields
      );

      // 手編集項目は維持
      expect(merged.name).toBe('ユーザー編集した銘柄名');
      expect((merged.categoryAttributes as { brewery?: string }).brewery).toBe('ユーザー指定の蔵元');
      expect(merged.description?.summary).toBe('ユーザーが書いた要約');
      expect(skippedFields).toContain('name');
      expect(skippedFields).toContain('categoryAttributes.brewery');
      expect(skippedFields).toContain('description.summary');

      // 未編集項目は Gemini の値で更新
      expect(merged.abv).toBe(16.0);
      expect((merged.categoryAttributes as { ricePolishingRatio?: string }).ricePolishingRatio).toBe('50%');
      expect(merged.description?.tasteProfile).toBe('華やかな香り');
      expect(merged.description?.background).toBe('100年の歴史');
      expect(merged.sources).toHaveLength(1);
      expect(merged.referencePrice?.estimatedPriceYen).toBe(4000);

      // 購入価格と相場目安が混ざらないこと
      expect(merged.purchaseInfo.purchasePriceYen).toBe(3200);
      expect(merged.referencePrice?.estimatedPriceYen).toBe(4000);
    });

    it('userEditedFields に指定されていても現在値が空の場合は Gemini の値で補完されること', () => {
      const bottleWithEmptyName = { ...existingBottle, name: '' };
      const { merged, skippedFields } = mergeGeminiPayloadIntoBottle(
        bottleWithEmptyName,
        geminiPayload,
        ['name']
      );

      // 空欄だったので補完される
      expect(merged.name).toBe('AIが推定した銘柄名');
      expect(skippedFields).not.toContain('name');
    });

    it('種類（category）が変更された場合、旧種類の属性は引き継がれず新種類の属性のみになること', () => {
      // 現在は日本酒（蔵元: 鳳凰酒造）
      const nihonshuBottle = createNewBottle({
        name: '謎のお酒',
        category: '日本酒',
        categoryAttributes: {
          brewery: '鳳凰酒造',
          specificName: '純米大吟醸',
        },
      });

      // Gemini がウイスキーと判定した場合
      const whiskyPayload: GeminiImportPayload = {
        name: '山崎 12年',
        category: 'ウイスキー',
        abv: 43.0,
        volumeMl: 700,
        categoryAttributes: {
          distillery: '山崎蒸溜所',
          ageStatement: '12年',
        },
        description: null,
        sources: [],
        referencePrice: null,
      };

      // ユーザーが旧種類の属性（brewery）を編集していたとしても、種類が変われば旧属性はクリアされる
      const { merged } = mergeGeminiPayloadIntoBottle(
        nihonshuBottle,
        whiskyPayload,
        ['categoryAttributes.brewery']
      );

      expect(merged.category).toBe('ウイスキー');
      const attrs = merged.categoryAttributes as Record<string, unknown>;
      expect(attrs['distillery']).toBe('山崎蒸溜所');
      expect(attrs['ageStatement']).toBe('12年');
      // 日本酒の旧属性が残っていないこと
      expect(attrs['brewery']).toBeUndefined();
      expect(attrs['specificName']).toBeUndefined();
    });
  });

  describe('findDuplicateBottles (重複検出)', () => {
    it('完全一致する銘柄（groupKey一致）と銘柄名一致を正しく検出し内訳を返すこと', () => {
      // SAMPLE_BOTTLES には「純米大吟醸 鳳凰」（720ml, opened）と（720ml, unopened）の2本が存在
      const res = findDuplicateBottles(SAMPLE_BOTTLES, {
        name: '純米大吟醸 鳳凰',
        category: '日本酒',
        volumeMl: 720,
      });

      expect(res.hasDuplicate).toBe(true);
      expect(res.nameMatches.length).toBeGreaterThanOrEqual(2);
      expect(res.exactMatches.length).toBeGreaterThanOrEqual(2);
      expect(res.breakdown.inventory).toBeGreaterThanOrEqual(2);
    });

    it('容量違いの同名銘柄の場合は nameMatches のみに含まれ exactMatches には含まれないこと', () => {
      const res = findDuplicateBottles(SAMPLE_BOTTLES, {
        name: '純米大吟醸 鳳凰',
        category: '日本酒',
        volumeMl: 1800, // サンプルには 720ml のみ存在
      });

      expect(res.hasDuplicate).toBe(true);
      expect(res.nameMatches.length).toBeGreaterThanOrEqual(2);
      expect(res.exactMatches).toHaveLength(0);
    });

    it('存在しない銘柄名の場合は hasDuplicate が false であること', () => {
      const res = findDuplicateBottles(SAMPLE_BOTTLES, {
        name: 'まったく新しい幻の酒 2026',
        category: '日本酒',
      });

      expect(res.hasDuplicate).toBe(false);
      expect(res.exactMatches).toHaveLength(0);
      expect(res.nameMatches).toHaveLength(0);
      expect(res.breakdown.inventory).toBe(0);
    });
  });

  describe('createReuseDraftFromBottle (既存銘柄からの流用)', () => {
    const sourceBottle = SAMPLE_BOTTLES[0]!;

    it('属性・解説・相場目安を引き継ぎつつ、写真IDは共有せず新しいUUIDが採番され対応表が返ること', () => {
      const { draft, photosToClone } = createReuseDraftFromBottle(sourceBottle, { copyPhotos: true });

      // 引き継がれる情報
      expect(draft.name).toBe(sourceBottle.name);
      expect(draft.category).toBe(sourceBottle.category);
      expect(draft.abv).toBe(sourceBottle.abv);
      expect(draft.volumeMl).toBe(sourceBottle.volumeMl);
      expect(draft.categoryAttributes).toEqual(sourceBottle.categoryAttributes);
      expect(draft.description).toEqual(sourceBottle.description);

      // 写真 ID は流用元と同一ではなく、新しい UUID が割り当てられていること
      expect(draft.photoIds).toHaveLength(sourceBottle.photoIds.length);
      expect(draft.photoIds).not.toEqual(sourceBottle.photoIds);
      expect(draft.primaryPhotoId).not.toBe(sourceBottle.primaryPhotoId);

      // photosToClone に元写真と新写真の対応が含まれること
      expect(photosToClone).toHaveLength(sourceBottle.photoIds.length);
      for (let i = 0; i < photosToClone.length; i++) {
        expect(photosToClone[i]?.sourcePhotoId).toBe(sourceBottle.photoIds[i]);
        expect(photosToClone[i]?.newPhotoId).toBe(draft.photoIds?.[i]);
      }

      // リセットされる情報
      expect(draft.status).toBe('unopened');
      expect(draft.openedDate).toBeNull();
      expect(draft.finishedDate).toBeNull();
      expect(draft.disposedDate).toBeNull();
      expect(draft.purchaseInfo?.purchaseDate).toBeNull();
      expect(draft.purchaseInfo?.purchasePlace).toBe('');
      expect(draft.purchaseInfo?.purchasePriceYen).toBeNull();
      expect(draft.tastingNote).toBe('');
      expect(draft.wantToBuyAgain).toBe(false);
      expect(draft.userEditedFields).toEqual([]);
    });

    it('copyPhotos: false の場合は写真配列および photosToClone が空になること', () => {
      const { draft, photosToClone } = createReuseDraftFromBottle(sourceBottle, { copyPhotos: false });
      expect(draft.photoIds).toEqual([]);
      expect(draft.primaryPhotoId).toBeNull();
      expect(photosToClone).toEqual([]);
    });
  });

  describe('createBottlesBatch (複数本一括生成)', () => {
    const input: CreateBottleInput<'ウイスキー'> = {
      name: '白州 12年',
      category: 'ウイスキー',
      volumeMl: 700,
      abv: 43.0,
      photoIds: ['photo-111', 'photo-222'],
      primaryPhotoId: 'photo-111',
    };

    it('指定本数分の独立した BottleRecord が生成され、それぞれ異なる UUID を持つこと', () => {
      const { bottles, photosToClone } = createBottlesBatch(input, 3);

      expect(bottles).toHaveLength(3);
      const idSet = new Set(bottles.map((b) => b.id));
      expect(idSet.size).toBe(3); // すべて異なる ID

      // 各ボトルの写真 ID もそれぞれ新しく採番され、元の写真は共有されないこと
      const allNewPhotoIds = bottles.flatMap((b) => b.photoIds);
      expect(new Set(allNewPhotoIds).size).toBe(6); // 3本 × 2枚 = 6枚

      // photosToClone に元写真と新写真の紐づけが記録されていること
      expect(photosToClone).toHaveLength(6);
      for (const ptc of photosToClone) {
        expect(['photo-111', 'photo-222']).toContain(ptc.sourcePhotoId);
        expect(allNewPhotoIds).toContain(ptc.newPhotoId);
        expect(idSet.has(ptc.bottleId)).toBe(true);
      }
    });

    it('本数指定が 1〜10 の範囲に安全に丸められること', () => {
      const res0 = createBottlesBatch(input, 0);
      expect(res0.bottles).toHaveLength(1);

      const res15 = createBottlesBatch(input, 15);
      expect(res15.bottles).toHaveLength(10);
    });
  });
});
