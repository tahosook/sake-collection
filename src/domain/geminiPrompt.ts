import {
  SakeCategory,
  SAKE_CATEGORIES,
  CategoryAttributes,
  SakeDescription,
  DescriptionSource,
  ReferencePriceInfo,
  BottleRecord,
} from '../types/sake';
import { CATEGORY_ATTRIBUTE_LABELS, isSakeCategory } from './categories';
import { isValidCalendarDate } from './validation';
import { getTodayDateString, CreateBottleInput } from './bottleUtils';

/**
 * 種類別の解説の軸定義（正本: docs/step2-design.md §2）
 */
export interface DescriptionAxis {
  tasteAxis: string;      // ② 味わいの軸
  backgroundAxis: string; // ③ 背景の軸
  servingAxis: string;    // ④ 飲み方の軸
}

export const CATEGORY_DESCRIPTION_AXES: Record<SakeCategory, DescriptionAxis> = {
  '日本酒': {
    tasteAxis: '香り（吟醸香・穏やかさ）、甘辛・酸味・旨味のバランス、口当たりとキレ',
    backgroundAxis: '蔵元の所在地・歴史、使用米・精米歩合・仕込みの特徴',
    servingAxis: 'おすすめの温度帯（雪冷え〜花冷え〜常温〜ぬる燗〜熱燗）、合う料理の系統',
  },
  'ワイン': {
    tasteAxis: '果実味、酸味、タンニン（渋み）・ボディ（重さ）または泡の質感、余韻',
    backgroundAxis: '生産者（ドメーヌ／ワイナリー）、産地（AOC/GI等）と畑・ヴィンテージの特徴',
    servingAxis: '適温、グラスの形状や抜栓後の変化、相性の良い料理',
  },
  'ウイスキー': {
    tasteAxis: 'ピート（スモーキーさ）の有無と強さ、樽由来の香味（シェリー樽・バーボン樽等）、甘みと余韻',
    backgroundAxis: '蒸留所の地域（スコッチ地域区分・ジャパニーズ等）・歴史、原酒構成・製法の特徴',
    servingAxis: 'ストレート／トワイスアップ／ロック／ハイボール等の向き不向き',
  },
  'ジン': {
    tasteAxis: 'ジュニパーベリーを基調とした主なボタニカルの香りの立ち方（柑橘・スパイス・ハーブ・フローラル等）、ドライさ',
    backgroundAxis: '蒸留所の国・地域、ベーススピリッツや特徴的なボタニカル・蒸留法',
    servingAxis: 'ジントニック／ジンソーダ／マティーニ等のカクテル適性、添えるガーニッシュ',
  },
  '焼酎': {
    tasteAxis: '原料（芋・麦・米・黒糖等）由来の香りと甘み、麹（黒麹・白麹・黄麹）や蒸留法（常圧・減圧）によるコクとキレ',
    backgroundAxis: '蔵元の所在地、原料品種や仕込み・熟成（甕貯蔵・樽熟成等）の特徴',
    servingAxis: 'ロック／水割り／お湯割り／ソーダ割り等の適した割り方',
  },
  'ビール': {
    tasteAxis: 'ホップの香りと苦味（IBU感）、モルトのコク・甘み・ロースト感、酸味やマウスフィール',
    backgroundAxis: 'ブルワリー（醸造所）の所在地・成り立ち、そのビアスタイルの特徴や副原料',
    servingAxis: '適温、注ぎ方やグラス、相性の良い食事',
  },
  'ブランデー': {
    tasteAxis: '果実香・熟成香（バニラ・ナッツ・ドライフルーツ・スパイス等）、まろやかさと余韻',
    backgroundAxis: '産地（コニャックのクリュ、アルマニャック、カルヴァドス等）、メゾンと熟成年数・等級の背景',
    servingAxis: 'ストレート（チューリップグラス等）、加水、食後酒としての楽しみ方',
  },
  'シェリー': {
    tasteAxis: 'タイプ（フィノ／マンサニージャ／オロロソ等）そのものが決める辛口・甘口、フロールや酸化熟成の風味',
    backgroundAxis: 'ボデガ（生産者）と熟成地、ソレラ・システムによる熟成の特徴',
    servingAxis: '適温（フィノ等はしっかり冷やす等）、タパス等の合わせ方',
  },
  'ウォッカ': {
    tasteAxis: '原料由来の口当たり（なめらかさ・とろみ・キレ）とほのかな甘み',
    backgroundAxis: '生産国・蒸留所、蒸留回数や濾過方法・仕込み水の特徴',
    servingAxis: '冷凍庫で冷やしてストレート、ソーダ・トニック割り、カクテルベース',
  },
  'その他': {
    tasteAxis: '主原料・製法に由来する香り、甘み・酸味・苦味・アルコール感のバランス',
    backgroundAxis: '生産者・産地、そのお酒の分類（リキュール・ラム・テキーラ等）と製法',
    servingAxis: 'ストレート／ロック／ソーダ割り等の定番の飲み方',
  },
};

/**
 * Gemini 相談用プロンプトを構築する純粋関数
 */
export function buildGeminiConsultationPrompt(options: {
  categoryHint?: SakeCategory;
  todayDate?: string;
} = {}): string {
  const today = options.todayDate ?? getTodayDateString();
  const categoryHintText = options.categoryHint
    ? `※お酒の種類ヒント: 「${options.categoryHint}」の可能性が高いです。`
    : '';

  return `添付した写真（お酒の表ラベル、裏ラベル、箱など）から情報を読み取り、Web検索で裏付けを取った上で、下記のJSON形式のみを出力してください。挨拶や補足文は一切含めず、\`\`\`json\`\`\`のコードブロック1つだけを出力してください。

【厳守する正確さの原則】
1. ラベルの文字と、信頼できるWeb情報（公式サイト・蔵元/蒸留所・正規輸入元・酒販店等）で確実に裏付けが取れた事実のみを書いてください。
2. 不確かな情報は絶対に推測で埋めず、属性値なら null、解説文中なら「不明」と明記してください。
3. 文体は事実ベースで淡々と書き、「至高の」「極上の」「奇跡の」といった宣伝文句や誇張は禁止します。
4. 解説（description）は4部構成（①ひとことで ②味わい ③背景 ④飲み方）とし、文字数は4部合計で300〜500字を目安としますが、不明点が多い場合は正確さを最優先して短くなって構いません。
5. 相場目安（referencePrice）は、日本国内の販売情報（税込目安の整数・日本円のみ）から推定してください。容量（volumeMl）が異なる商品の相場は絶対に混ぜないでください。同一商品・同一容量と確認できない場合は無理に推定せず estimatedPriceYen を null にしてください。
6. category は必ず次の10種類の中から最も適切なものを1つ選んでください:
   ["日本酒", "ワイン", "ウイスキー", "ジン", "焼酎", "ビール", "ブランデー", "シェリー", "ウォッカ", "その他"]

${categoryHintText}

【出力JSONフォーマット】
\`\`\`json
{
  "name": "銘柄名・商品名（特定名称や年号を含めた正式名称）",
  "category": "日本酒",
  "abv": 15.0,
  "volumeMl": 720,
  "categoryAttributes": {
    /* 種類に応じた主要属性。不明な項目はキー自体を省略するかnullにしてください。
     * 日本酒: brewery（蔵元）, ricePolishingRatio（精米歩合、例: "50%"）, specificName（特定名称、例: "純米大吟醸"）
     * ワイン: grapeVarieties（品種）, region（産地）, wineType（赤/白/泡等）, vintageYear（年、西暦数値またはnull）
     * ウイスキー: distillery（蒸留所）, ageStatement（熟成年数、例: "12年"）
     * ジン: distillery（蒸留所）, botanicals（主なボタニカル）
     * 焼酎: ingredients（原材料）, brewery（蔵元）
     * ビール: beerStyle（スタイル）, brewery（醸造所）
     * ブランデー: region（産地）, grade（等級、例: "XO"）
     * シェリー: sherryType（タイプ、例: "Fino"）, bodega（ボデガ）
     * ウォッカ: ingredients（原料）, region（産地）
     * その他: （空オブジェクト）
     */
  },
  "description": {
    "summary": "① ひとことで（概要と特徴、1〜2文）",
    "tasteProfile": "② 味わい（香り・甘辛・酸味・ボディ・キレなど、種類に応じた軸で淡々と記述）",
    "background": "③ 背景・歴史（生産者の所在地や歴史、製法・原材料・こだわりの背景）",
    "servingSuggestion": "④ おすすめの飲み方（適した温度帯やグラス、割り方、合わせる料理）"
  },
  "sources": [
    {
      "title": "参照元のサイト名または記事タイトル",
      "url": "https://example.com/..."
    }
  ],
  "referencePrice": {
    "estimatedPriceYen": 3500,
    "fetchedDate": "${today}",
    "note": "720ml 税込希望小売価格の目安（確認できない場合はnull）"
  }
}
\`\`\``;
}

/**
 * Gemini から取り込む JSON の型定義
 */
export interface GeminiImportPayload {
  name: string;
  category: SakeCategory;
  abv: number | null;
  volumeMl: number | null;
  categoryAttributes: Record<string, string | number | null>;
  description: SakeDescription | null;
  sources: DescriptionSource[];
  referencePrice: ReferencePriceInfo | null;
}

/**
 * Gemini 取り込みの検証結果型
 */
export type GeminiValidationResult =
  | {
      success: true;
      data: GeminiImportPayload;
      warnings: string[];
    }
  | {
      success: false;
      errors: string[];
    };

/**
 * Markdown コードブロックや前後テキストから JSON 文字列を抽出する
 */
export function extractJsonFromText(rawText: string): string {
  const trimmed = rawText.trim();

  // ```json ... ``` または ``` ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].trim();
  }

  // 先頭の '{' から末尾の '}' までを抽出
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

/**
 * Gemini 取り込み JSON を構文解析・2段階検証する純粋関数
 *
 * エラー（弾く）：構文エラー、オブジェクトでない、name 欠落/空、未知の種類、不正な数値型
 * 警告（通す）：未知属性キーの除外、不正 URL の除外、相場目安取得日補完、解説の一部の欠落
 */
export function parseAndValidateGeminiJson(
  rawInput: unknown,
  options: { todayDate?: string } = {}
): GeminiValidationResult {
  const today = options.todayDate ?? getTodayDateString();
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 文字列の場合は JSON 構文抽出・パース
  let parsed: unknown = rawInput;
  if (typeof rawInput === 'string') {
    const jsonStr = extractJsonFromText(rawInput);
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return {
        success: false,
        errors: ['JSONの形式が正しくありません。Geminiの出力が途中で切れていないか確認してください。'],
      };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      success: false,
      errors: ['取り込みデータの形式が不正です（JSONオブジェクトである必要があります）。'],
    };
  }

  const obj = parsed as Record<string, unknown>;

  // 2. 必須項目: name (非空文字列)
  if (typeof obj['name'] !== 'string' || obj['name'].trim().length === 0) {
    errors.push('必須項目「名前（銘柄名）」が含まれていないか空欄です。');
  }
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';

  // 3. 必須項目: category (固定10種)
  if (!isSakeCategory(obj['category'])) {
    const catStr = String(obj['category'] ?? '');
    errors.push(
      `種類「${catStr}」は未対応です（対応種類: ${SAKE_CATEGORIES.join(', ')}）。`
    );
  }
  const category = (isSakeCategory(obj['category']) ? obj['category'] : 'その他') as SakeCategory;

  // 4. 数値項目: abv (度数) - 数値型または null のみ受理（暗黙変換・文字列・真偽値は拒否）
  let abv: number | null = null;
  if (obj['abv'] === undefined || obj['abv'] === null) {
    abv = null;
  } else if (typeof obj['abv'] === 'number' && !isNaN(obj['abv']) && obj['abv'] >= 0 && obj['abv'] <= 100) {
    abv = obj['abv'];
  } else {
    errors.push('度数（abv）は 0〜100 の数値または null である必要があります。');
  }

  // 5. 数値項目: volumeMl (容量) - 正の数値型または null のみ受理（暗黙変換・文字列・真偽値は拒否、丸め後が1未満の場合も拒否）
  let volumeMl: number | null = null;
  if (obj['volumeMl'] === undefined || obj['volumeMl'] === null) {
    volumeMl = null;
  } else if (typeof obj['volumeMl'] === 'number' && !isNaN(obj['volumeMl']) && obj['volumeMl'] > 0) {
    const rounded = Math.round(obj['volumeMl']);
    if (rounded < 1) {
      errors.push('容量（volumeMl）は正の数値または null である必要があります。');
    } else {
      volumeMl = rounded;
    }
  } else {
    errors.push('容量（volumeMl）は正の数値または null である必要があります。');
  }

  // 6. 相場目安の予備チェック（基本数値型エラーを即座に検出するため）
  let estPrice: number | null = null;
  if (typeof obj['referencePrice'] === 'object' && obj['referencePrice'] !== null && !Array.isArray(obj['referencePrice'])) {
    const r = obj['referencePrice'] as Record<string, unknown>;
    if (r['estimatedPriceYen'] === undefined || r['estimatedPriceYen'] === null) {
      estPrice = null;
    } else if (typeof r['estimatedPriceYen'] === 'number' && !isNaN(r['estimatedPriceYen']) && r['estimatedPriceYen'] >= 0) {
      estPrice = Math.round(r['estimatedPriceYen']);
    } else {
      errors.push('相場目安（estimatedPriceYen）は 0 以上の数値または null である必要があります。');
    }
  }

  // エラーがあれば即座に返却
  if (errors.length > 0) {
    return { success: false, errors };
  }

  // 6. 種類別追加属性: categoryAttributes
  const categoryAttributes: Record<string, string | number | null> = {};
  const allowedAttrs = CATEGORY_ATTRIBUTE_LABELS[category];

  if (typeof obj['categoryAttributes'] === 'object' && obj['categoryAttributes'] !== null && !Array.isArray(obj['categoryAttributes'])) {
    const rawAttrs = obj['categoryAttributes'] as Record<string, unknown>;
    for (const [key, val] of Object.entries(rawAttrs)) {
      if (key in allowedAttrs) {
        if (val === null || val === undefined || val === '' || val === '不明') {
          categoryAttributes[key] = null;
        } else if (key === 'vintageYear') {
          const numYear = Number(val);
          if (!isNaN(numYear) && numYear >= 1800 && numYear <= 2100) {
            categoryAttributes[key] = numYear;
          } else {
            categoryAttributes[key] = null;
            warnings.push(`ワインの年号「${String(val)}」が不正だったため空欄にしました。`);
          }
        } else {
          categoryAttributes[key] = String(val).trim();
        }
      } else {
        warnings.push(`${category}に未定義の属性キー「${key}」を無視しました。`);
      }
    }
  }

  // 7. 解説: description (4部構成)
  let description: SakeDescription | null = null;
  if (typeof obj['description'] === 'object' && obj['description'] !== null && !Array.isArray(obj['description'])) {
    const desc = obj['description'] as Record<string, unknown>;
    const summary = typeof desc['summary'] === 'string' ? desc['summary'].trim() : '';
    const tasteProfile = typeof desc['tasteProfile'] === 'string' ? desc['tasteProfile'].trim() : '';
    const background = typeof desc['background'] === 'string' ? desc['background'].trim() : '';
    const servingSuggestion = typeof desc['servingSuggestion'] === 'string' ? desc['servingSuggestion'].trim() : '';

    if (!summary && !tasteProfile && !background && !servingSuggestion) {
      warnings.push('解説の全項目が空でした。');
    } else {
      if (!summary || !tasteProfile || !background || !servingSuggestion) {
        warnings.push('解説の4部のうち一部が空欄です。');
      }
      description = {
        summary,
        tasteProfile,
        background,
        servingSuggestion,
      };
    }
  } else if (obj['description'] !== null && obj['description'] !== undefined) {
    warnings.push('解説データがオブジェクト形式でなかったため無視しました。');
  }

  // 8. 出典: sources (URLリスト)
  const sources: DescriptionSource[] = [];
  if (Array.isArray(obj['sources'])) {
    for (const src of obj['sources']) {
      if (typeof src === 'object' && src !== null) {
        const s = src as Record<string, unknown>;
        const url = typeof s['url'] === 'string' ? s['url'].trim() : '';
        const title = typeof s['title'] === 'string' ? s['title'].trim() : undefined;

        if (url.startsWith('http://') || url.startsWith('https://')) {
          sources.push({
            url,
            ...(title ? { title } : {}),
          });
        } else if (url.length > 0) {
          warnings.push(`不正な形式の出典URL「${url}」を除外しました。`);
        }
      }
    }
  }

  // 9. 相場目安: referencePrice (購入価格とは完全分離)
  let referencePrice: ReferencePriceInfo | null = null;
  if (typeof obj['referencePrice'] === 'object' && obj['referencePrice'] !== null && !Array.isArray(obj['referencePrice'])) {
    const r = obj['referencePrice'] as Record<string, unknown>;

    let fetchedDate: string | null = null;
    if (typeof r['fetchedDate'] === 'string' && isValidCalendarDate(r['fetchedDate'].trim())) {
      fetchedDate = r['fetchedDate'].trim();
    } else if (estPrice !== null) {
      fetchedDate = today;
      warnings.push(`相場目安の取得日を本日の日付（${today}）で補完しました。`);
    }

    const note = typeof r['note'] === 'string' && r['note'].trim().length > 0
      ? r['note'].trim()
      : undefined;

    if (estPrice !== null || fetchedDate !== null || note !== undefined) {
      referencePrice = {
        estimatedPriceYen: estPrice,
        fetchedDate,
        ...(note ? { note } : {}),
      };
    }
  }

  return {
    success: true,
    data: {
      name,
      category,
      abv,
      volumeMl,
      categoryAttributes,
      description,
      sources,
      referencePrice,
    },
    warnings,
  };
}

export interface MergeResult<T> {
  merged: T;
  skippedFields: string[];
}

/**
 * ユーザーの手編集項目（userEditedFields）を上書きから保護しつつ、
 * Gemini 取り込み結果を現在の入力データにマージする純粋関数
 */
export function mergeGeminiPayloadIntoBottle<T extends CreateBottleInput | BottleRecord>(
  current: T,
  payload: GeminiImportPayload,
  userEditedFields: string[] = []
): MergeResult<T> {
  const editedSet = new Set(userEditedFields);
  const skippedFields: string[] = [];

  const shouldOverwrite = (fieldKey: string): boolean => {
    if (editedSet.has(fieldKey)) {
      // ユーザーが手動編集した項目は、現在値の有無（空欄・null）にかかわらず保護する
      skippedFields.push(fieldKey);
      return false;
    }
    return true;
  };

  // 1. name
  const name = shouldOverwrite('name')
    ? payload.name
    : current.name;

  // 2. category
  const category = shouldOverwrite('category')
    ? payload.category
    : current.category;

  // 3. abv
  const abv = shouldOverwrite('abv')
    ? payload.abv
    : current.abv;

  // 4. volumeMl
  const volumeMl = shouldOverwrite('volumeMl')
    ? payload.volumeMl
    : current.volumeMl;

  // 5. categoryAttributes（種類変更時は旧属性を引き継がず、旧属性の編集保護フラグも無効化）
  const isCategoryChanged = category !== current.category;
  const currentAttrs = (current.categoryAttributes ?? {}) as Record<string, unknown>;
  const mergedAttrs: Record<string, unknown> = isCategoryChanged ? {} : { ...currentAttrs };

  if (category === payload.category) {
    for (const [key, val] of Object.entries(payload.categoryAttributes)) {
      if (isCategoryChanged) {
        if (val !== null) {
          mergedAttrs[key] = val;
        }
      } else {
        const fieldKey = `categoryAttributes.${key}`;
        if (shouldOverwrite(fieldKey)) {
          if (val !== null) {
            mergedAttrs[key] = val;
          } else {
            delete mergedAttrs[key];
          }
        }
      }
    }
  }

  // 6. description
  let mergedDescription: SakeDescription | null = null;
  const currentDesc = current.description ?? {
    summary: '',
    tasteProfile: '',
    background: '',
    servingSuggestion: '',
  };
  const payloadDesc = payload.description ?? {
    summary: '',
    tasteProfile: '',
    background: '',
    servingSuggestion: '',
  };

  const summary = shouldOverwrite('description.summary')
    ? payloadDesc.summary
    : currentDesc.summary;

  const tasteProfile = shouldOverwrite('description.tasteProfile')
    ? payloadDesc.tasteProfile
    : currentDesc.tasteProfile;

  const background = shouldOverwrite('description.background')
    ? payloadDesc.background
    : currentDesc.background;

  const servingSuggestion = shouldOverwrite('description.servingSuggestion')
    ? payloadDesc.servingSuggestion
    : currentDesc.servingSuggestion;

  if (summary || tasteProfile || background || servingSuggestion) {
    mergedDescription = {
      summary,
      tasteProfile,
      background,
      servingSuggestion,
    };
  }

  // 7. sources
  let mergedSources: DescriptionSource[] = [];
  if (shouldOverwrite('sources')) {
    mergedSources = payload.sources ? [...payload.sources] : [];
  } else {
    mergedSources = current.sources ? [...current.sources] : [];
  }

  // 8. referencePrice（購入価格 purchasePriceYen とは完全に別フィールド）
  let mergedReferencePrice: ReferencePriceInfo | null = null;
  if (shouldOverwrite('referencePrice')) {
    mergedReferencePrice = payload.referencePrice ? { ...payload.referencePrice } : null;
  } else {
    mergedReferencePrice = current.referencePrice ? { ...current.referencePrice } : null;
  }

  const merged = {
    ...current,
    name,
    category,
    abv,
    volumeMl,
    categoryAttributes: mergedAttrs as CategoryAttributes,
    description: mergedDescription,
    sources: mergedSources,
    referencePrice: mergedReferencePrice,
  };

  return {
    merged: merged as T,
    skippedFields,
  };
}
