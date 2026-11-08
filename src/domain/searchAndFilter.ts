import { BottleRecord, SakeCategory, BottleStatus } from '../types/sake';

export type StatusFilterOption = 'all' | 'in_stock' | BottleStatus;

export interface FilterOptions {
  /** 種類フィルタ ('all' で全種類) */
  category?: SakeCategory | 'all';
  /** 状態フィルタ ('all', 'in_stock', 'unopened', 'opened', 'finished', 'disposed') */
  status?: StatusFilterOption;
  /** 検索キーワード (名前＋主要属性を部分一致検索) */
  query?: string;
  /** 論理削除されたレコードを含めるか (既定は false) */
  includeDeleted?: boolean;
}

/**
 * ボトルの検索対象テキスト群を抽出する
 * 名前および各種類別の主要属性を結合して検索対象文字列を生成
 */
export function extractSearchableText(bottle: BottleRecord): string {
  const parts: string[] = [bottle.name];

  const attrs = bottle.categoryAttributes as Record<string, unknown>;
  const targetAttrKeys = [
    'brewery',            // 蔵元 (日本酒, 焼酎) / 醸造所 (ビール)
    'distillery',         // 蒸留所 (ウイスキー, ジン)
    'bodega',             // ボデガ (シェリー)
    'region',             // 産地 (ワイン, ブランデー, ウォッカ)
    'grapeVarieties',     // 品種 (ワイン)
    'specificName',       // 特定名称 (日本酒)
    'beerStyle',          // スタイル (ビール)
    'wineType',           // タイプ (ワイン)
    'sherryType',         // タイプ (シェリー)
    'botanicals',         // 主なボタニカル (ジン)
    'ingredients',        // 原材料・原料 (焼酎, ウォッカ)
    'grade',              // 等級 (ブランデー)
  ];

  for (const key of targetAttrKeys) {
    const val = attrs[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      parts.push(val);
    }
  }

  return parts.join(' ').toLowerCase();
}

/**
 * 検索クエリに合致するか判定する
 * 複数単語（スペース区切り）の場合は AND 検索（すべてが含まれること）
 */
export function matchesQuery(bottle: BottleRecord, query?: string): boolean {
  if (!query || query.trim().length === 0) {
    return true;
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) {
    return true;
  }

  const searchableText = extractSearchableText(bottle);
  return terms.every((term) => searchableText.includes(term));
}

/**
 * ボトル配列を条件に応じて絞り込む
 *
 * 絞り込みは1本単位で適用され、まとめ表示の前に適用する
 */
export function filterBottles(bottles: BottleRecord[], options: FilterOptions = {}): BottleRecord[] {
  const {
    category = 'all',
    status = 'all',
    query = '',
    includeDeleted = false,
  } = options;

  return bottles.filter((bottle) => {
    // 1. 論理削除フィルタ
    if (!includeDeleted && bottle.deleted) {
      return false;
    }

    // 2. 種類フィルタ
    if (category !== 'all' && bottle.category !== category) {
      return false;
    }

    // 3. 状態フィルタ
    if (status === 'in_stock') {
      if (bottle.status !== 'unopened' && bottle.status !== 'opened') {
        return false;
      }
    } else if (status !== 'all') {
      if (bottle.status !== status) {
        return false;
      }
    }

    // 4. キーワード検索
    if (!matchesQuery(bottle, query)) {
      return false;
    }

    return true;
  });
}

/**
 * 検索結果を「家にある酒」と「飲んだ記録」に分離して取得する
 * （要件: 検索は一覧と飲んだ記録の両方に及ぶ）
 */
export interface CrossViewSearchResult {
  /** 家にある酒 (未開封・開封済み) */
  inStockBottles: BottleRecord[];
  /** 飲んだ記録 (飲み切り) */
  finishedBottles: BottleRecord[];
  /** 手放した酒 */
  disposedBottles: BottleRecord[];
}

export function searchAcrossCollections(
  bottles: BottleRecord[],
  query: string,
  category: SakeCategory | 'all' = 'all'
): CrossViewSearchResult {
  const matched = filterBottles(bottles, {
    category,
    status: 'all',
    query,
    includeDeleted: false,
  });

  return {
    inStockBottles: matched.filter((b) => b.status === 'unopened' || b.status === 'opened'),
    finishedBottles: matched.filter((b) => b.status === 'finished'),
    disposedBottles: matched.filter((b) => b.status === 'disposed'),
  };
}
