import {
  BottleRecord,
  BottleRecordBase,
  BottleStatus,
  SakeCategory,
  CategoryAttributesMap,
  PurchaseInfo,
  SakeDescription,
  DescriptionSource,
  ReferencePriceInfo,
} from '../types/sake';
import { isValidCalendarDate } from './validation';
import { generateGroupKey, normalizeSakeName } from './sortAndGroup';

/**
 * 現在の日付文字列を YYYY-MM-DD 形式で取得する (ローカル暦日基準)
 */
export function getTodayDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 開封日数を計算する純粋関数
 *
 * 要件:
 * - bottle.status === 'opened' かつ bottle.openedDate !== null の場合のみ計算
 * - それ以外（未開封、飲み切り、手放した、または開封日未入力）は必ず null を返す
 * - 一覧画面には表示せず、詳細画面の開封日欄に補助表示する
 *
 * @param bottle 対象ボトル
 * @param targetDate 比較対象基準日 (省略時は当日)
 * @returns 開封からの経過日数（0以上）、または計算対象外の場合は null
 */
export function calculateOpenedDays(
  bottle: BottleRecord,
  targetDate: string = getTodayDateString()
): number | null {
  if (bottle.status !== 'opened' || !bottle.openedDate) {
    return null;
  }

  // 実在する日付かチェック
  if (!isValidCalendarDate(bottle.openedDate) || !isValidCalendarDate(targetDate)) {
    return null;
  }

  const [openedY, openedM, openedD] = bottle.openedDate.split('-').map(Number);
  const [targetY, targetM, targetD] = targetDate.split('-').map(Number);

  if (openedY === undefined || openedM === undefined || openedD === undefined ||
      targetY === undefined || targetM === undefined || targetD === undefined) {
    return null;
  }

  const openedUtc = Date.UTC(openedY, openedM - 1, openedD);
  const targetUtc = Date.UTC(targetY, targetM - 1, targetD);

  const diffMs = targetUtc - openedUtc;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // 未来の開封日が入力されている場合は 0 とする
  return Math.max(0, diffDays);
}

/**
 * ボトルの状態遷移と日付ルールの自動処理
 *
 * 要件:
 * - 状態を変えたら対応する日付が自動設定され、日付は手修正・空欄化もできる
 * - 状態変更は取り消せる
 * - 未開封のとき開封日・飲み切り日・手放した日は空欄（null）
 * - 変更時に updatedAt を現在時刻（ISO 8601 UTC）に更新する
 */
export function transitionBottleStatus<C extends SakeCategory>(
  bottle: BottleRecord<C>,
  newStatus: BottleStatus,
  options: {
    /** 手動指定日付 (YYYY-MM-DD または null、省略時は当日自動設定) */
    dateOverride?: string | null;
    /** 更新日時 (テスト用) */
    nowIso?: string;
  } = {}
): BottleRecord<C> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const today = getTodayDateString();

  let openedDate = bottle.openedDate;
  let finishedDate = bottle.finishedDate;
  let disposedDate = bottle.disposedDate;

  if (newStatus === 'unopened') {
    // 未開封に変更（取り消し含む）: すべての日付を必ず null にクリア
    openedDate = null;
    finishedDate = null;
    disposedDate = null;
  } else if (newStatus === 'opened') {
    // 開封済みに変更:
    // options.dateOverride が明示されていればそれ（null 指定含む）
    // 指定がなく既存の openedDate があれば維持、なければ当日
    if (options.dateOverride !== undefined) {
      openedDate = options.dateOverride;
    } else if (!openedDate) {
      openedDate = today;
    }
    finishedDate = null;
    disposedDate = null;
  } else if (newStatus === 'finished') {
    // 飲み切りに変更:
    if (options.dateOverride !== undefined) {
      finishedDate = options.dateOverride;
    } else {
      finishedDate = today;
    }
    disposedDate = null;
  } else if (newStatus === 'disposed') {
    // 手放したに変更:
    if (options.dateOverride !== undefined) {
      disposedDate = options.dateOverride;
    } else {
      disposedDate = today;
    }
    finishedDate = null;
  }

  return {
    ...bottle,
    status: newStatus,
    openedDate,
    finishedDate,
    disposedDate,
    updatedAt: nowIso,
  };
}

export interface CreateBottleInput<C extends SakeCategory = SakeCategory> {
  name: string;
  category: C;
  status?: BottleStatus;
  abv?: number | null;
  volumeMl?: number | null;
  categoryAttributes?: CategoryAttributesMap[C];
  openedDate?: string | null;
  finishedDate?: string | null;
  disposedDate?: string | null;
  purchaseInfo?: Partial<PurchaseInfo>;
  tastingNote?: string;
  wantToBuyAgain?: boolean;
  description?: SakeDescription | null;
  sources?: DescriptionSource[];
  referencePrice?: ReferencePriceInfo | null;
  photoIds?: string[];
  primaryPhotoId?: string | null;
  userEditedFields?: string[];
}

/**
 * 最小手入力登録用の新しい BottleRecord を生成する純粋関数
 */
export function createNewBottle<C extends SakeCategory>(
  input: CreateBottleInput<C>,
  options: { nowIso?: string; id?: string } = {}
): BottleRecord<C> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const id = options.id ?? crypto.randomUUID();
  const status = input.status ?? 'unopened';

  let openedDate = input.openedDate ?? null;
  let finishedDate = input.finishedDate ?? null;
  let disposedDate = input.disposedDate ?? null;

  // 未開封時の日付強制 null 制約
  if (status === 'unopened') {
    openedDate = null;
    finishedDate = null;
    disposedDate = null;
  } else if (status === 'opened') {
    finishedDate = null;
    disposedDate = null;
  } else if (status === 'finished') {
    disposedDate = null;
  } else if (status === 'disposed') {
    finishedDate = null;
  }

  const purchaseInfo: PurchaseInfo = {
    purchaseDate: input.purchaseInfo?.purchaseDate ?? null,
    purchasePlace: input.purchaseInfo?.purchasePlace ?? '',
    purchasePriceYen: input.purchaseInfo?.purchasePriceYen ?? null,
  };

  const emptyAttrs = {} as CategoryAttributesMap[C];

  const photoIds = input.photoIds ? [...input.photoIds] : [];
  let primaryPhotoId: string | null = input.primaryPhotoId ?? null;
  if (!primaryPhotoId && photoIds.length > 0) {
    primaryPhotoId = photoIds[0] ?? null;
  } else if (primaryPhotoId && !photoIds.includes(primaryPhotoId)) {
    primaryPhotoId = photoIds[0] ?? null;
  }

  const record: BottleRecordBase<C> = {
    id,
    createdAt: nowIso,
    updatedAt: nowIso,
    deleted: false,
    name: input.name.trim(),
    category: input.category,
    abv: input.abv ?? null,
    volumeMl: input.volumeMl ?? null,
    categoryAttributes: input.categoryAttributes ?? emptyAttrs,
    status,
    openedDate,
    finishedDate,
    disposedDate,
    tastingNote: input.tastingNote ?? '',
    wantToBuyAgain: input.wantToBuyAgain ?? false,
    description: input.description ?? null,
    sources: input.sources ? [...input.sources] : [],
    purchaseInfo,
    referencePrice: input.referencePrice ?? null,
    photoIds,
    primaryPhotoId,
    userEditedFields: input.userEditedFields ? [...input.userEditedFields] : [],
  };

  return record as unknown as BottleRecord<C>;
}

/**
 * 重複銘柄検出の結果型
 */
export interface DuplicateDetectionResult {
  hasDuplicate: boolean;
  exactMatches: BottleRecord[];
  nameMatches: BottleRecord[];
  breakdown: {
    inventory: number; // 家にある酒 (unopened / opened)
    finished: number;  // 飲んだ記録
    disposed: number;  // 手放した酒
  };
}

/**
 * 既存ボトル一覧から同一銘柄の重複を検出する純粋関数
 */
export function findDuplicateBottles(
  bottles: BottleRecord[],
  target: {
    name: string;
    category: SakeCategory;
    volumeMl?: number | null;
    vintageYear?: number | null;
  }
): DuplicateDetectionResult {
  const normTargetName = normalizeSakeName(target.name);
  if (!normTargetName) {
    return {
      hasDuplicate: false,
      exactMatches: [],
      nameMatches: [],
      breakdown: { inventory: 0, finished: 0, disposed: 0 },
    };
  }

  const validBottles = bottles.filter((b) => !b.deleted);
  const exactMatches: BottleRecord[] = [];
  const nameMatches: BottleRecord[] = [];

  // 仮想的な target ボトルを作成して groupKey を取得
  const dummyTargetBottle: BottleRecord = {
    name: target.name,
    category: target.category,
    volumeMl: target.volumeMl ?? null,
    categoryAttributes: (target.category === 'ワイン'
      ? { vintageYear: target.vintageYear ?? null }
      : {}) as BottleRecord['categoryAttributes'],
  } as BottleRecord;
  const targetGroupKey = generateGroupKey(dummyTargetBottle);

  for (const b of validBottles) {
    const isSameCategory = b.category === target.category;
    const isSameName = normalizeSakeName(b.name) === normTargetName;

    if (isSameCategory && isSameName) {
      nameMatches.push(b);
      if (generateGroupKey(b) === targetGroupKey) {
        exactMatches.push(b);
      }
    }
  }

  // 検出対象ボトルのユニーク集合から状態内訳を集計
  const matchedBottles = nameMatches;
  let inventory = 0;
  let finished = 0;
  let disposed = 0;

  for (const b of matchedBottles) {
    if (b.status === 'unopened' || b.status === 'opened') {
      inventory++;
    } else if (b.status === 'finished') {
      finished++;
    } else if (b.status === 'disposed') {
      disposed++;
    }
  }

  return {
    hasDuplicate: matchedBottles.length > 0,
    exactMatches,
    nameMatches,
    breakdown: {
      inventory,
      finished,
      disposed,
    },
  };
}

/**
 * 既存ボトル流用ドラフト生成の結果型
 */
export interface CreateReuseDraftResult<C extends SakeCategory = SakeCategory> {
  draft: CreateBottleInput<C>;
  photosToClone: Array<{
    sourcePhotoId: string;
    newPhotoId: string;
  }>;
}

/**
 * 既存ボトルから2本目以降の流用登録用ドラフトを生成する純粋関数
 * 写真は流用元の ID を共有せず、新しい写真 ID（UUID）を割り当てて複製元との対応関係を返す
 */
export function createReuseDraftFromBottle<C extends SakeCategory = SakeCategory>(
  source: BottleRecord<C>,
  options: { copyPhotos?: boolean } = {}
): CreateReuseDraftResult<C> {
  const copyPhotos = options.copyPhotos ?? true;
  const newPhotoIds: string[] = [];
  const photosToClone: Array<{ sourcePhotoId: string; newPhotoId: string }> = [];
  let newPrimaryPhotoId: string | null = null;

  if (copyPhotos && source.photoIds.length > 0) {
    for (const srcPid of source.photoIds) {
      const newPid = crypto.randomUUID();
      newPhotoIds.push(newPid);
      photosToClone.push({
        sourcePhotoId: srcPid,
        newPhotoId: newPid,
      });

      if (srcPid === source.primaryPhotoId) {
        newPrimaryPhotoId = newPid;
      }
    }

    if (!newPrimaryPhotoId && newPhotoIds.length > 0) {
      newPrimaryPhotoId = newPhotoIds[0] ?? null;
    }
  }

  const draft: CreateBottleInput<C> = {
    name: source.name,
    category: source.category as C,
    status: 'unopened', // 既定は未開封にリセット
    abv: source.abv,
    volumeMl: source.volumeMl,
    categoryAttributes: { ...source.categoryAttributes } as CategoryAttributesMap[C],
    openedDate: null,
    finishedDate: null,
    disposedDate: null,
    purchaseInfo: {
      purchaseDate: null,
      purchasePlace: '',
      purchasePriceYen: null,
    },
    tastingNote: '',
    wantToBuyAgain: false,
    description: source.description ? { ...source.description } : null,
    sources: source.sources ? source.sources.map((s) => ({ ...s })) : [],
    referencePrice: source.referencePrice ? { ...source.referencePrice } : null,
    photoIds: newPhotoIds,
    primaryPhotoId: newPrimaryPhotoId,
    userEditedFields: [],
  };

  return {
    draft,
    photosToClone,
  };
}

/**
 * 複数本一括登録（および写真の個別複製対応）の生成結果
 */
export interface BatchCreateResult<C extends SakeCategory = SakeCategory> {
  bottles: BottleRecord<C>[];
  photosToClone: Array<{
    sourcePhotoId: string;
    newPhotoId: string;
    bottleId: string;
  }>;
}

/**
 * 同内容で指定本数（1〜10本）のボトルレコード群を生成する純粋関数
 * 1本ごとに独立した UUID を付与し、写真がある場合は各ボトル用に新しい PhotoRecord ID を割り振る
 */
export function createBottlesBatch<C extends SakeCategory>(
  input: CreateBottleInput<C>,
  count: number,
  options: { nowIso?: string } = {}
): BatchCreateResult<C> {
  const safeCount = Math.max(1, Math.min(10, Math.floor(count)));
  const nowIso = options.nowIso ?? new Date().toISOString();
  const bottles: BottleRecord<C>[] = [];
  const photosToClone: Array<{
    sourcePhotoId: string;
    newPhotoId: string;
    bottleId: string;
  }> = [];

  const sourcePhotoIds = input.photoIds ?? [];
  const sourcePrimaryId = input.primaryPhotoId ?? (sourcePhotoIds[0] ?? null);

  for (let i = 0; i < safeCount; i++) {
    const bottleId = crypto.randomUUID();

    // 各ボトル固有の写真 ID マッピングを生成
    const newPhotoIds: string[] = [];
    let newPrimaryPhotoId: string | null = null;

    for (const srcPid of sourcePhotoIds) {
      const newPid = crypto.randomUUID();
      newPhotoIds.push(newPid);
      photosToClone.push({
        sourcePhotoId: srcPid,
        newPhotoId: newPid,
        bottleId,
      });

      if (srcPid === sourcePrimaryId) {
        newPrimaryPhotoId = newPid;
      }
    }

    if (!newPrimaryPhotoId && newPhotoIds.length > 0) {
      newPrimaryPhotoId = newPhotoIds[0] ?? null;
    }

    const bottleInput: CreateBottleInput<C> = {
      ...input,
      photoIds: newPhotoIds,
      primaryPhotoId: newPrimaryPhotoId,
    };

    const record = createNewBottle(bottleInput, {
      nowIso,
      id: bottleId,
    });

    bottles.push(record);
  }

  return {
    bottles,
    photosToClone,
  };
}
