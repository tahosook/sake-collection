import { BackupData, BottleRecord, PhotoRecord, SakeCategory, BottleStatus } from '../types/sake';
import { SAKE_CATEGORIES, BOTTLE_STATUSES } from '../types/sake';
import { CATEGORY_ATTRIBUTE_LABELS } from './categories';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HASH_HEX_REGEX = /^[0-9a-f]{64}$/i;

/**
 * YYYY-MM-DD 形式の日付文字列が暦日として実在するか判定する
 * うるう年や各月の日数（2月29日/30日、4月31日等）の不正を検出
 */
export function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  if (!yearStr || !monthStr || !dayStr) {
    return false;
  }
  const y = Number(yearStr);
  const m = Number(monthStr);
  const d = Number(dayStr);

  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) {
    return false;
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * 単一ボトルのオブジェクトを厳密にスキーマ検証する
 */
export function validateBottleRecord(raw: unknown, indexHint?: number | string): ValidationResult<BottleRecord> {
  const prefix = indexHint !== undefined ? `[ボトル #${indexHint}] ` : '';

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { success: false, error: `${prefix}ボトルデータがオブジェクトではありません。` };
  }

  const b = raw as Record<string, unknown>;

  // 必須 ID (UUID)
  if (typeof b['id'] !== 'string' || !UUID_REGEX.test(b['id'])) {
    return { success: false, error: `${prefix}ID が不正です（UUID形式である必要があります: ${String(b['id'])}）。` };
  }

  // 名前 (必須・非空)
  if (typeof b['name'] !== 'string' || b['name'].trim().length === 0) {
    return { success: false, error: `${prefix}名前は空にできません (id: ${b['id']})。` };
  }

  // 種類 (固定10種)
  if (typeof b['category'] !== 'string' || !SAKE_CATEGORIES.includes(b['category'] as SakeCategory)) {
    return {
      success: false,
      error: `${prefix}未知の種類です: '${String(b['category'])}' (許可: ${SAKE_CATEGORIES.join(', ')})。`,
    };
  }
  const category = b['category'] as SakeCategory;

  // 状態 (固定4種)
  if (typeof b['status'] !== 'string' || !BOTTLE_STATUSES.includes(b['status'] as BottleStatus)) {
    return {
      success: false,
      error: `${prefix}未知の状態です: '${String(b['status'])}' (許可: ${BOTTLE_STATUSES.join(', ')})。`,
    };
  }
  const status = b['status'] as BottleStatus;

  // 日時 (ISO 8601 UTC)
  if (typeof b['createdAt'] !== 'string' || !ISO_DATE_REGEX.test(b['createdAt'])) {
    return { success: false, error: `${prefix}createdAt が有効な ISO 8601 UTC 日時ではありません: ${String(b['createdAt'])}` };
  }
  if (typeof b['updatedAt'] !== 'string' || !ISO_DATE_REGEX.test(b['updatedAt'])) {
    return { success: false, error: `${prefix}updatedAt が有効な ISO 8601 UTC 日時ではありません: ${String(b['updatedAt'])}` };
  }
  if (typeof b['deleted'] !== 'boolean') {
    return { success: false, error: `${prefix}deleted フラグが真偽値ではありません。` };
  }

  // 状態と日付の整合性制約
  const openedDate = b['openedDate'];
  const finishedDate = b['finishedDate'];
  const disposedDate = b['disposedDate'];

  if (openedDate !== null && (typeof openedDate !== 'string' || !isValidCalendarDate(openedDate))) {
    return { success: false, error: `${prefix}openedDate は実在する有効な日付 (YYYY-MM-DD) または null である必要があります: ${String(openedDate)}` };
  }
  if (finishedDate !== null && (typeof finishedDate !== 'string' || !isValidCalendarDate(finishedDate))) {
    return { success: false, error: `${prefix}finishedDate は実在する有効な日付 (YYYY-MM-DD) または null である必要があります: ${String(finishedDate)}` };
  }
  if (disposedDate !== null && (typeof disposedDate !== 'string' || !isValidCalendarDate(disposedDate))) {
    return { success: false, error: `${prefix}disposedDate は実在する有効な日付 (YYYY-MM-DD) または null である必要があります: ${String(disposedDate)}` };
  }

  if (status === 'unopened') {
    if (openedDate !== null || finishedDate !== null || disposedDate !== null) {
      return { success: false, error: `${prefix}未開封ボトルの開封日・飲み切り日・手放した日はすべて null である必要があります。` };
    }
  } else if (status === 'opened') {
    if (finishedDate !== null || disposedDate !== null) {
      return { success: false, error: `${prefix}開封済みボトルの飲み切り日・手放した日は null である必要があります。` };
    }
  } else if (status === 'finished') {
    if (disposedDate !== null) {
      return { success: false, error: `${prefix}飲み切りボトルの手放した日は null である必要があります。` };
    }
  } else if (status === 'disposed') {
    if (finishedDate !== null) {
      return { success: false, error: `${prefix}手放したボトルの飲み切り日は null である必要があります。` };
    }
  }

  // 度数・容量 (数値または null)
  if (b['abv'] !== null && (typeof b['abv'] !== 'number' || b['abv'] < 0 || b['abv'] > 100)) {
    return { success: false, error: `${prefix}度数 (abv) は 0〜100 の数値または null である必要があります。` };
  }
  if (b['volumeMl'] !== null && (typeof b['volumeMl'] !== 'number' || b['volumeMl'] <= 0)) {
    return { success: false, error: `${prefix}容量 (volumeMl) は正の数値または null である必要があります。` };
  }

  // 種類別属性 (categoryAttributes)
  if (typeof b['categoryAttributes'] !== 'object' || b['categoryAttributes'] === null) {
    return { success: false, error: `${prefix}categoryAttributes がオブジェクトではありません。` };
  }
  const allowedAttrs = CATEGORY_ATTRIBUTE_LABELS[category];
  const actualKeys = Object.keys(b['categoryAttributes']);
  for (const k of actualKeys) {
    if (!(k in allowedAttrs)) {
      return {
        success: false,
        error: `${prefix}種類 '${category}' に許可されていない属性キー '${k}' が含まれています。`,
      };
    }
  }

  // 購入情報 (purchaseInfo)
  if (typeof b['purchaseInfo'] !== 'object' || b['purchaseInfo'] === null) {
    return { success: false, error: `${prefix}purchaseInfo がオブジェクトではありません。` };
  }
  const pInfo = b['purchaseInfo'] as Record<string, unknown>;
  if (pInfo['purchaseDate'] !== null && (typeof pInfo['purchaseDate'] !== 'string' || !isValidCalendarDate(pInfo['purchaseDate']))) {
    return { success: false, error: `${prefix}購入日 (purchaseDate) は実在する有効な日付 (YYYY-MM-DD) または null である必要があります: ${String(pInfo['purchaseDate'])}` };
  }
  if (typeof pInfo['purchasePlace'] !== 'string') {
    return { success: false, error: `${prefix}購入場所 (purchasePlace) は文字列である必要があります。` };
  }
  if (pInfo['purchasePriceYen'] !== null && (typeof pInfo['purchasePriceYen'] !== 'number' || pInfo['purchasePriceYen'] < 0)) {
    return { success: false, error: `${prefix}購入価格 (purchasePriceYen) は 0 以上の数値または null である必要があります。` };
  }

  // 相場目安 (referencePrice - 購入価格と構造上完全分離)
  if (b['referencePrice'] !== null) {
    if (typeof b['referencePrice'] !== 'object' || b['referencePrice'] === null) {
      return { success: false, error: `${prefix}referencePrice はオブジェクトまたは null である必要があります。` };
    }
    const rPrice = b['referencePrice'] as Record<string, unknown>;
    if (rPrice['estimatedPriceYen'] !== null && (typeof rPrice['estimatedPriceYen'] !== 'number' || rPrice['estimatedPriceYen'] < 0)) {
      return { success: false, error: `${prefix}相場目安推定値 (estimatedPriceYen) は正の数値または null である必要があります。` };
    }
    if (rPrice['fetchedDate'] !== null && (typeof rPrice['fetchedDate'] !== 'string' || !isValidCalendarDate(rPrice['fetchedDate']))) {
      return { success: false, error: `${prefix}相場目安取得日 (fetchedDate) は実在する有効な日付 (YYYY-MM-DD) または null である必要があります: ${String(rPrice['fetchedDate'])}` };
    }
  }

  // 写真参照 (photoIds, primaryPhotoId)
  if (!Array.isArray(b['photoIds'])) {
    return { success: false, error: `${prefix}photoIds は配列である必要があります。` };
  }
  for (const pid of b['photoIds']) {
    if (typeof pid !== 'string' || !UUID_REGEX.test(pid)) {
      return { success: false, error: `${prefix}photoIds に不正な UUID が含まれています: ${String(pid)}` };
    }
  }
  if (b['primaryPhotoId'] !== null) {
    if (typeof b['primaryPhotoId'] !== 'string' || !UUID_REGEX.test(b['primaryPhotoId'])) {
      return { success: false, error: `${prefix}primaryPhotoId が不正な UUID です: ${String(b['primaryPhotoId'])}` };
    }
    if (!b['photoIds'].includes(b['primaryPhotoId'])) {
      return { success: false, error: `${prefix}primaryPhotoId は photoIds に含まれる必要があります。` };
    }
  }

  // 感想・印・ユーザー編集フィールド
  if (typeof b['tastingNote'] !== 'string') {
    return { success: false, error: `${prefix}tastingNote は文字列である必要があります。` };
  }
  if (typeof b['wantToBuyAgain'] !== 'boolean') {
    return { success: false, error: `${prefix}wantToBuyAgain は真偽値である必要があります。` };
  }
  if (!Array.isArray(b['userEditedFields'])) {
    return { success: false, error: `${prefix}userEditedFields は配列である必要があります。` };
  }

  // 解説・出典 (description, sources)
  if (b['description'] !== null) {
    if (typeof b['description'] !== 'object' || b['description'] === null || Array.isArray(b['description'])) {
      return { success: false, error: `${prefix}解説 (description) はオブジェクトまたは null である必要があります。` };
    }
    const desc = b['description'] as Record<string, unknown>;
    if (
      typeof desc['summary'] !== 'string' ||
      typeof desc['tasteProfile'] !== 'string' ||
      typeof desc['background'] !== 'string' ||
      typeof desc['servingSuggestion'] !== 'string'
    ) {
      return { success: false, error: `${prefix}解説 (description) の 4部構成フィールド (summary, tasteProfile, background, servingSuggestion) は文字列である必要があります。` };
    }
  }

  if (!Array.isArray(b['sources'])) {
    return { success: false, error: `${prefix}sources は配列である必要があります。` };
  }
  for (let i = 0; i < (b['sources'] as unknown[]).length; i++) {
    const src = (b['sources'] as unknown[])[i];
    if (typeof src !== 'object' || src === null || Array.isArray(src)) {
      return { success: false, error: `${prefix}sources[${i}] はオブジェクトである必要があります。` };
    }
    const s = src as Record<string, unknown>;
    let isValidUrl = false;
    if (typeof s['url'] === 'string') {
      try {
        const parsedUrl = new URL(s['url']);
        isValidUrl = (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') && parsedUrl.hostname.length > 0;
      } catch {
        isValidUrl = false;
      }
    }
    if (!isValidUrl) {
      return { success: false, error: `${prefix}出典URL (sources[${i}].url) は http または https の有効なURL文字列である必要があります: ${String(s['url'])}` };
    }
    if (s['title'] !== undefined && typeof s['title'] !== 'string') {
      return { success: false, error: `${prefix}出典タイトル (sources[${i}].title) は文字列である必要があります。` };
    }
  }

  return { success: true, data: raw as BottleRecord };
}

/**
 * 単一写真レコードを厳密にスキーマ検証する
 */
export function validatePhotoRecord(raw: unknown, indexHint?: number | string): ValidationResult<PhotoRecord> {
  const prefix = indexHint !== undefined ? `[写真 #${indexHint}] ` : '';

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { success: false, error: `${prefix}写真データがオブジェクトではありません。` };
  }

  const p = raw as Record<string, unknown>;

  if (typeof p['id'] !== 'string' || !UUID_REGEX.test(p['id'])) {
    return { success: false, error: `${prefix}写真ID が不正です（UUID形式である必要があります）。` };
  }
  if (typeof p['bottleId'] !== 'string' || !UUID_REGEX.test(p['bottleId'])) {
    return { success: false, error: `${prefix}写真の bottleId が不正です（UUID形式である必要があります）。` };
  }
  if (p['mimeType'] !== 'image/jpeg' && p['mimeType'] !== 'image/webp') {
    return { success: false, error: `${prefix}写真の mimeType は 'image/jpeg' または 'image/webp' である必要があります。` };
  }
  if (typeof p['dataUrl'] !== 'string' || !p['dataUrl'].startsWith(`data:${p['mimeType']};base64,`)) {
    return { success: false, error: `${prefix}写真の dataUrl は 'data:${p['mimeType']};base64,' で始まる必要があります。` };
  }
  if (typeof p['contentHash'] !== 'string' || !HASH_HEX_REGEX.test(p['contentHash'])) {
    return { success: false, error: `${prefix}写真の contentHash は64桁の16進数文字列 (SHA-256) である必要があります。` };
  }
  if (typeof p['width'] !== 'number' || !Number.isInteger(p['width']) || (p['width'] as number) <= 0) {
    return { success: false, error: `${prefix}写真の width は正の整数である必要があります: ${String(p['width'])}` };
  }
  if (typeof p['height'] !== 'number' || !Number.isInteger(p['height']) || (p['height'] as number) <= 0) {
    return { success: false, error: `${prefix}写真の height は正の整数である必要があります: ${String(p['height'])}` };
  }
  if (typeof p['byteSize'] !== 'number' || !Number.isInteger(p['byteSize']) || (p['byteSize'] as number) <= 0) {
    return { success: false, error: `${prefix}写真の byteSize は正の整数である必要があります: ${String(p['byteSize'])}` };
  }
  if (p['driveFileId'] !== null && (typeof p['driveFileId'] !== 'string' || (p['driveFileId'] as string).trim() === '')) {
    return { success: false, error: `${prefix}写真の driveFileId は非空の文字列または null である必要があります: ${String(p['driveFileId'])}` };
  }
  if (typeof p['createdAt'] !== 'string' || !ISO_DATE_REGEX.test(p['createdAt'])) {
    return { success: false, error: `${prefix}写真の createdAt が有効な ISO 8601 UTC 日時ではありません。` };
  }
  if (typeof p['updatedAt'] !== 'string' || !ISO_DATE_REGEX.test(p['updatedAt'])) {
    return { success: false, error: `${prefix}写真の updatedAt が有効な ISO 8601 UTC 日時ではありません。` };
  }
  if (typeof p['deleted'] !== 'boolean') {
    return { success: false, error: `${prefix}写真の deleted が真偽値ではありません。` };
  }

  return { success: true, data: raw as PhotoRecord };
}

/**
 * バックアップ JSON を厳密に2段階検証する純粋関数
 *
 * 要件:
 * 1. JSON 構文解析：パース失敗時は「バックアップファイルのJSON形式が正しくありません。」
 * 2. スキーマ・整合性検証：schemaVersion === 1, bottles / photos 配列、全レコードの型と制約、双方向参照整合性
 * 3. 検証失敗時は部分取り込みを一切行わずエラーを返す（アトミックな拒否）
 */
export function validateBackupData(input: unknown): ValidationResult<BackupData> {
  // 1. JSON 構文解析 (文字列で渡された場合)
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { success: false, error: 'バックアップファイルのJSON形式が正しくありません。ファイルを確認してください。' };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { success: false, error: 'バックアップファイルのデータ構造が不正です（ルートがオブジェクトではありません）。' };
  }

  const root = parsed as Record<string, unknown>;

  // schemaVersion
  if (root['schemaVersion'] !== 1) {
    return { success: false, error: `未対応のスキーマバージョンです: ${String(root['schemaVersion'])}（バージョン 1 のみ対応）。` };
  }

  // exportedAt
  if (typeof root['exportedAt'] !== 'string' || !ISO_DATE_REGEX.test(root['exportedAt'])) {
    return { success: false, error: '出力日時 (exportedAt) が有効な ISO 8601 UTC 形式ではありません。' };
  }

  // 配列の存在確認
  if (!Array.isArray(root['bottles'])) {
    return { success: false, error: 'bottles 配列が存在しません。' };
  }
  if (!Array.isArray(root['photos'])) {
    return { success: false, error: 'photos 配列が存在しません。' };
  }

  // ボトル全件検証
  const validatedBottles: BottleRecord[] = [];
  const bottleIdMap = new Map<string, BottleRecord>();

  for (let i = 0; i < root['bottles'].length; i++) {
    const bRes = validateBottleRecord(root['bottles'][i], i + 1);
    if (!bRes.success) {
      return bRes;
    }
    if (bottleIdMap.has(bRes.data.id)) {
      return { success: false, error: `重複するボトル ID が見つかりました: ${bRes.data.id}` };
    }
    bottleIdMap.set(bRes.data.id, bRes.data);
    validatedBottles.push(bRes.data);
  }

  // 写真全件検証
  const validatedPhotos: PhotoRecord[] = [];
  const photoMap = new Map<string, PhotoRecord>();

  for (let i = 0; i < root['photos'].length; i++) {
    const pRes = validatePhotoRecord(root['photos'][i], i + 1);
    if (!pRes.success) {
      return pRes;
    }
    if (photoMap.has(pRes.data.id)) {
      return { success: false, error: `重複する写真 ID が見つかりました: ${pRes.data.id}` };
    }
    photoMap.set(pRes.data.id, pRes.data);

    // 写真の親ボトル参照整合性 (写真 -> ボトル)
    const parentBottle = bottleIdMap.get(pRes.data.bottleId);
    if (!parentBottle) {
      return {
        success: false,
        error: `写真 ${pRes.data.id} の親ボトル ${pRes.data.bottleId} がバックアップ内に存在しません。`,
      };
    }
    if (!parentBottle.photoIds.includes(pRes.data.id)) {
      return {
        success: false,
        error: `親ボトル ${pRes.data.bottleId} の photoIds に写真 ${pRes.data.id} が含まれていません。`,
      };
    }

    validatedPhotos.push(pRes.data);
  }

  // ボトル側から写真への参照整合性 (ボトル -> 写真)
  for (const bottle of validatedBottles) {
    for (const pid of bottle.photoIds) {
      const photo = photoMap.get(pid);
      if (!photo) {
        return {
          success: false,
          error: `ボトル ${bottle.id} の photoId ${pid} に対応する写真レコードが存在しません。`,
        };
      }
      if (photo.bottleId !== bottle.id) {
        return {
          success: false,
          error: `ボトル ${bottle.id} の photoIds に含まれる写真 ${pid} の持ち主（bottleId: ${photo.bottleId}）が一致しません。`,
        };
      }
    }
  }

  return {
    success: true,
    data: {
      schemaVersion: 1,
      exportedAt: root['exportedAt'],
      bottles: validatedBottles,
      photos: validatedPhotos,
    },
  };
}

/**
 * 単一ボトルの取り込み JSON（Gemini 相談結果や手動インポート用）を検証する
 */
export function validateImportBottleJson(input: unknown): ValidationResult<BottleRecord> {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { success: false, error: '取り込み JSON の構文が正しくありません。' };
    }
  }
  return validateBottleRecord(parsed);
}
