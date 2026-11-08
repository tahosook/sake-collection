import { BottleRecord, SakeCategory, BottleStatus } from '../types/sake';
import { CATEGORY_ORDER } from './categories';

/**
 * 表示用のグループ化されたボトル群
 */
export interface BottleGroup {
  /** 一意なグループキー (`${category}::${normalizedName}::${normalizedVolume}::${vintageKey}`) */
  groupKey: string;
  /** 正規化された銘柄名 */
  name: string;
  /** 種類 */
  category: SakeCategory;
  /** 容量 (ml, 未指定は null) */
  volumeMl: number | null;
  /** ワインの年 (ヴィンテージ, ワイン以外または未指定は null) */
  vintageYear: number | null;
  /** グループ内のボトル一覧 (compareBottles でソート済み) */
  bottles: BottleRecord[];
  /** グループ内の有効ボトル本数 */
  count: number;
  /** グループ先頭の代表ボトル */
  primaryBottle: BottleRecord;
  /** グループの最優先状態 (1本でも opened があれば opened、なければ unopened) */
  priorityStatus: 'opened' | 'unopened';
  /** グループ内の最新有効購入日 (YYYY-MM-DD) */
  latestEffectivePurchaseDate: string;
  /** 代表写真ID (先頭ボトルの代表写真、なければグループ内で写真を持つ最初の写真) */
  primaryPhotoId: string | null;
}

/**
 * ボトルの有効購入日を取得する
 * purchaseDate が未入力（null または空文字）の場合は createdAt の日付部分（YYYY-MM-DD）で代用
 */
export function getEffectivePurchaseDate(bottle: BottleRecord): string {
  if (bottle.purchaseInfo.purchaseDate && bottle.purchaseInfo.purchaseDate.trim().length > 0) {
    return bottle.purchaseInfo.purchaseDate.trim();
  }
  return bottle.createdAt.slice(0, 10);
}

/**
 * 銘柄名を正規化する（前後空白除去＋連続空白を1つの半角スペースに統一）
 */
export function normalizeSakeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/**
 * 同一銘柄キーを生成する
 * ルール:
 * - normalizedName
 * - category
 * - volumeMl (null のときは 'unknown')
 * - vintageKey (ワインの場合のみ vintageYear ?? 'nv'、ワイン以外は固定値 '')
 */
export function generateGroupKey(bottle: BottleRecord): string {
  const normName = normalizeSakeName(bottle.name);
  const volKey = bottle.volumeMl !== null ? `${bottle.volumeMl}ml` : 'unknown';

  let vintageKey = '';
  if (bottle.category === 'ワイン') {
    const wineAttrs = bottle.categoryAttributes as { vintageYear?: number | null };
    vintageKey = wineAttrs.vintageYear !== undefined && wineAttrs.vintageYear !== null
      ? String(wineAttrs.vintageYear)
      : 'nv';
  }

  return `${bottle.category}::${normName}::${volKey}::${vintageKey}`;
}

/**
 * 1本単位の並び順比較関数
 * 優先順位:
 * 1. 状態: opened（開封済み）が先、unopened（未開封）が後
 * 2. 種類の記載順: SAKE_CATEGORIES の順序（日本酒 → ワイン → ... → その他）
 * 3. 有効購入日の新しい順（降順）
 * 4. タイブレーク: createdAt 降順 → id 辞書順昇順
 */
export function compareBottles(a: BottleRecord, b: BottleRecord): number {
  // 1. 状態優先度 (opened > unopened)
  const statusScore = (status: BottleStatus): number => {
    if (status === 'opened') return 0;
    if (status === 'unopened') return 1;
    if (status === 'finished') return 2;
    return 3; // disposed
  };
  const scoreDiff = statusScore(a.status) - statusScore(b.status);
  if (scoreDiff !== 0) return scoreDiff;

  // 2. 種類の記載順
  const catOrderA = CATEGORY_ORDER[a.category] ?? 999;
  const catOrderB = CATEGORY_ORDER[b.category] ?? 999;
  if (catOrderA !== catOrderB) return catOrderA - catOrderB;

  // 3. 有効購入日の新しい順 (降順)
  const dateA = getEffectivePurchaseDate(a);
  const dateB = getEffectivePurchaseDate(b);
  if (dateA !== dateB) {
    return dateB.localeCompare(dateA);
  }

  // 4. タイブレーク: createdAt 降順
  if (a.createdAt !== b.createdAt) {
    return b.createdAt.localeCompare(a.createdAt);
  }

  // 最終タイブレーク: id 辞書順
  return a.id.localeCompare(b.id);
}

/**
 * グループ間の並び順比較関数
 * 優先順位:
 * 1. グループの最優先状態 (opened > unopened)
 * 2. 種類の記載順
 * 3. グループ内の最新有効購入日 (降順)
 * 4. タイブレーク: 代表ボトルの createdAt 降順 → groupKey 辞書順昇順
 */
export function compareGroups(a: BottleGroup, b: BottleGroup): number {
  // 1. 最優先状態
  if (a.priorityStatus !== b.priorityStatus) {
    return a.priorityStatus === 'opened' ? -1 : 1;
  }

  // 2. 種類の記載順
  const catOrderA = CATEGORY_ORDER[a.category] ?? 999;
  const catOrderB = CATEGORY_ORDER[b.category] ?? 999;
  if (catOrderA !== catOrderB) return catOrderA - catOrderB;

  // 3. 最新有効購入日の新しい順 (降順)
  if (a.latestEffectivePurchaseDate !== b.latestEffectivePurchaseDate) {
    return b.latestEffectivePurchaseDate.localeCompare(a.latestEffectivePurchaseDate);
  }

  // 4. タイブレーク: primaryBottle の createdAt 降順
  if (a.primaryBottle.createdAt !== b.primaryBottle.createdAt) {
    return b.primaryBottle.createdAt.localeCompare(a.primaryBottle.createdAt);
  }

  // 最終タイブレーク: groupKey 辞書順
  return a.groupKey.localeCompare(b.groupKey);
}

/**
 * 一覧表示用にボトル配列をまとめ表示（グループ化）する純粋関数
 *
 * 要件:
 * - 対象は未開封・開封済み (status in ('unopened', 'opened')) かつ deleted でないボトル。
 * - 名前＋種類＋容量が一致＝同じ銘柄、ワインの年違いは別銘柄。
 * - グループ化は表示時の計算で、データは1本単位のまま。
 * - 絞り込み後の配列を渡すことで、表示本数（count）は絞り込み後の数となる。
 */
export function groupBottlesForDisplay(bottles: BottleRecord[]): BottleGroup[] {
  // 1. 「いま家にある酒」のみを対象とする（未開封・開封済み かつ 未削除）
  const inStockBottles = bottles.filter(
    (b) => !b.deleted && (b.status === 'unopened' || b.status === 'opened')
  );

  // 2. グループキーごとに分類
  const groupMap = new Map<string, BottleRecord[]>();
  for (const bottle of inStockBottles) {
    const key = generateGroupKey(bottle);
    const existing = groupMap.get(key);
    if (existing) {
      existing.push(bottle);
    } else {
      groupMap.set(key, [bottle]);
    }
  }

  // 3. 各グループのプロパティを計算
  const groups: BottleGroup[] = [];
  for (const [groupKey, groupBottles] of groupMap.entries()) {
    // グループ内のボトルをソート
    groupBottles.sort(compareBottles);

    const primaryBottle = groupBottles[0];
    if (!primaryBottle) continue;

    // 最優先状態 (1本でも opened があれば opened)
    const priorityStatus: 'opened' | 'unopened' = groupBottles.some(
      (b) => b.status === 'opened'
    )
      ? 'opened'
      : 'unopened';

    // 最新有効購入日 (最大値)
    let latestEffectivePurchaseDate = getEffectivePurchaseDate(groupBottles[0]!);
    for (let i = 1; i < groupBottles.length; i++) {
      const d = getEffectivePurchaseDate(groupBottles[i]!);
      if (d > latestEffectivePurchaseDate) {
        latestEffectivePurchaseDate = d;
      }
    }

    // 代表写真ID (先頭ボトルの代表写真、なければグループ内で写真を持つ最初の写真)
    let primaryPhotoId: string | null = primaryBottle.primaryPhotoId;
    if (!primaryPhotoId && primaryBottle.photoIds.length > 0) {
      primaryPhotoId = primaryBottle.photoIds[0] ?? null;
    }
    if (!primaryPhotoId) {
      for (const b of groupBottles) {
        if (b.primaryPhotoId) {
          primaryPhotoId = b.primaryPhotoId;
          break;
        }
        if (b.photoIds.length > 0 && b.photoIds[0]) {
          primaryPhotoId = b.photoIds[0];
          break;
        }
      }
    }

    let vintageYear: number | null = null;
    if (primaryBottle.category === 'ワイン') {
      const wineAttrs = primaryBottle.categoryAttributes as { vintageYear?: number | null };
      vintageYear = wineAttrs.vintageYear ?? null;
    }

    groups.push({
      groupKey,
      name: normalizeSakeName(primaryBottle.name),
      category: primaryBottle.category,
      volumeMl: primaryBottle.volumeMl,
      vintageYear,
      bottles: groupBottles,
      count: groupBottles.length,
      primaryBottle,
      priorityStatus,
      latestEffectivePurchaseDate,
      primaryPhotoId: primaryPhotoId ?? null,
    });
  }

  // 4. グループ間をソート
  groups.sort(compareGroups);

  return groups;
}
