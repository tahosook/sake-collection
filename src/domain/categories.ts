import { SAKE_CATEGORIES, SakeCategory } from '../types/sake';

export { SAKE_CATEGORIES };
export type { SakeCategory };

/**
 * 種類の固定順序マップ（配列の記載順）
 * 並び順の比較関数などで使用
 */
export const CATEGORY_ORDER: Record<SakeCategory, number> = SAKE_CATEGORIES.reduce(
  (acc, category, index) => {
    acc[category] = index;
    return acc;
  },
  {} as Record<SakeCategory, number>
);

/**
 * 種類別属性の表示ラベル定義（日本語）
 */
export const CATEGORY_ATTRIBUTE_LABELS: {
  [K in SakeCategory]: Record<string, string>;
} = {
  '日本酒': {
    brewery: '蔵元',
    ricePolishingRatio: '精米歩合',
    specificName: '特定名称',
  },
  'ワイン': {
    grapeVarieties: '品種',
    region: '産地',
    wineType: 'タイプ',
    vintageYear: '年（ヴィンテージ）',
  },
  'ウイスキー': {
    distillery: '蒸留所',
    ageStatement: '熟成年数',
  },
  'ジン': {
    distillery: '蒸留所',
    botanicals: '主なボタニカル',
  },
  '焼酎': {
    ingredients: '原材料',
    brewery: '蔵元',
  },
  'ビール': {
    beerStyle: 'スタイル',
    brewery: '醸造所',
  },
  'ブランデー': {
    region: '産地',
    grade: '等級',
  },
  'シェリー': {
    sherryType: 'タイプ',
    bodega: 'ボデガ',
  },
  'ウォッカ': {
    ingredients: '原料',
    region: '産地',
  },
  'その他': {},
};

/**
 * 渡された文字列が有効な SakeCategory か判定するガード関数
 */
export function isSakeCategory(value: unknown): value is SakeCategory {
  return typeof value === 'string' && SAKE_CATEGORIES.includes(value as SakeCategory);
}
