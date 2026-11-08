/**
 * sake-collection データモデル定義（ステップ1〜4共通・確定版）
 * docs/architecture.md および docs/step1-design.md に準拠
 */

export const SAKE_CATEGORIES = [
  '日本酒',
  'ワイン',
  'ウイスキー',
  'ジン',
  '焼酎',
  'ビール',
  'ブランデー',
  'シェリー',
  'ウォッカ',
  'その他',
] as const;

export type SakeCategory = (typeof SAKE_CATEGORIES)[number];

export const BOTTLE_STATUSES = [
  'unopened', // 未開封
  'opened',   // 開封済み
  'finished', // 飲み切り
  'disposed', // 手放した
] as const;

export type BottleStatus = (typeof BOTTLE_STATUSES)[number];

// 種類別追加属性（最小限）
export interface NihonshuAttributes {
  brewery?: string;            // 蔵元
  ricePolishingRatio?: string; // 精米歩合（例: "50%"）
  specificName?: string;       // 特定名称（例: "純米大吟醸"）
}

export interface WineAttributes {
  grapeVarieties?: string;     // 品種
  region?: string;             // 産地
  wineType?: string;           // タイプ（赤・白・泡・ロゼ・オレンジ等）
  vintageYear?: number | null; // 年（ヴィンテージ）。まとめ表示の別銘柄判定に使用
}

export interface WhiskyAttributes {
  distillery?: string;         // 蒸留所
  ageStatement?: string;       // 熟成年数
}

export interface GinAttributes {
  distillery?: string;         // 蒸留所
  botanicals?: string;         // 主なボタニカル
}

export interface ShochuAttributes {
  ingredients?: string;        // 原材料
  brewery?: string;            // 蔵元
}

export interface BeerAttributes {
  beerStyle?: string;          // スタイル
  brewery?: string;            // 醸造所
}

export interface BrandyAttributes {
  region?: string;             // 産地
  grade?: string;              // 等級（VSOP, XO等）
}

export interface SherryAttributes {
  sherryType?: string;         // タイプ（Fino, Manzanilla, Oloroso等）
  bodega?: string;             // ボデガ
}

export interface VodkaAttributes {
  ingredients?: string;        // 原料
  region?: string;             // 産地
}

export interface OtherAttributes {
  [key: string]: never;
}

export type CategoryAttributesMap = {
  '日本酒': NihonshuAttributes;
  'ワイン': WineAttributes;
  'ウイスキー': WhiskyAttributes;
  'ジン': GinAttributes;
  '焼酎': ShochuAttributes;
  'ビール': BeerAttributes;
  'ブランデー': BrandyAttributes;
  'シェリー': SherryAttributes;
  'ウォッカ': VodkaAttributes;
  'その他': OtherAttributes;
};

export type CategoryAttributes = CategoryAttributesMap[SakeCategory];

/** 4部構成の解説 */
export interface SakeDescription {
  summary: string;           // ① ひとことで
  tasteProfile: string;      // ② 味わい
  background: string;        // ③ 背景
  servingSuggestion: string; // ④ 飲み方
}

/** 解説の出典URL */
export interface DescriptionSource {
  title?: string;
  url: string;
}

/** 購入情報（任意） */
export interface PurchaseInfo {
  purchaseDate: string | null;     // YYYY-MM-DD（未入力はnull）
  purchasePlace: string;           // 購入場所（未入力は""）
  purchasePriceYen: number | null; // 購入価格（円・未入力はnull）
}

/** 相場目安（購入価格とは完全に別フィールドとして保持） */
export interface ReferencePriceInfo {
  estimatedPriceYen: number | null; // 推定値（円）
  fetchedDate: string | null;       // 取得日（YYYY-MM-DD、相談実行日）
  note?: string;                    // 容量条件などの補足（任意）
}

/** ボトル1本レコード（1本＝1レコード、最初から同期前提） */
export interface BottleRecord<C extends SakeCategory = SakeCategory> {
  // 同期・識別メタデータ
  id: string;                  // UUID v4
  createdAt: string;           // ISO 8601 UTC（購入日未入力時の並び代用にも使う）
  updatedAt: string;           // ISO 8601 UTC（同期マージの比較基準）
  deleted: boolean;            // 論理削除フラグ

  // 基本属性
  name: string;                // 名前（必須）
  category: C;                 // 種類（固定10種、必須）
  abv: number | null;          // 度数（%、例: 16.0）
  volumeMl: number | null;     // 容量（ml、例: 720, 750, 700）
  categoryAttributes: CategoryAttributesMap[C]; // 種類別の追加項目

  // 状態と日付（YYYY-MM-DD または null）
  status: BottleStatus;        // 未開封 / 開封済み / 飲み切り / 手放した
  openedDate: string | null;   // 開封日（未開封のときは必ず null）
  finishedDate: string | null; // 飲み切り日（未開封のときは必ず null）
  disposedDate: string | null; // 手放した日（未開封のときは必ず null）

  // 記録・印
  tastingNote: string;         // 感想メモ（1本に1つ、上書き形式）
  wantToBuyAgain: boolean;     // 「また買いたい」の印

  // 解説・出典
  description: SakeDescription | null;
  sources: DescriptionSource[];

  // 購入情報・相場目安（構造上明確に分離・混ぜない・上書きしない）
  purchaseInfo: PurchaseInfo;
  referencePrice: ReferencePriceInfo | null;

  // 写真参照
  photoIds: string[];            // 紐づく PhotoRecord.id の順序付き配列
  primaryPhotoId: string | null; // 代表写真ID（未指定時は photoIds[0]）

  // 編集保護メタデータ（ステップ2のGemini再取り込み時に上書きしないフィールド名一覧）
  userEditedFields: string[];
}

/** 写真レコード（端末内 IndexedDB 保持・ステップ4で Drive 連携） */
export interface PhotoRecord {
  id: string;                  // UUID v4 (photoId)
  bottleId: string;            // 紐づく BottleRecord.id
  mimeType: 'image/jpeg' | 'image/webp';
  dataUrl: string;             // リサイズ・EXIF 除去済みデータ（IndexedDB保持・バックアップ・Drive転送用）
  width: number;
  height: number;
  byteSize: number;
  contentHash: string;         // SHA-256 hex（重複転送防止・同一性確認）
  driveFileId: string | null;  // ステップ4で Google Drive 保存後に設定
  createdAt: string;           // ISO 8601 UTC
  updatedAt: string;           // ISO 8601 UTC
  deleted: boolean;            // 論理削除フラグ
}

/** バックアップデータ構造 */
export interface BackupData {
  schemaVersion: 1;
  exportedAt: string;          // ISO 8601 UTC
  bottles: BottleRecord[];
  photos: PhotoRecord[];
}
