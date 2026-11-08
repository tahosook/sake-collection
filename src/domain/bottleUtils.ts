import { BottleRecord, BottleRecordBase, BottleStatus, SakeCategory, CategoryAttributesMap, PurchaseInfo } from '../types/sake';

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

  // YYYY-MM-DD の形式チェック
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(bottle.openedDate) || !dateRegex.test(targetDate)) {
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
    description: null,
    sources: [],
    purchaseInfo,
    referencePrice: null,
    photoIds: [],
    primaryPhotoId: null,
    userEditedFields: [],
  };

  return record as unknown as BottleRecord<C>;
}
