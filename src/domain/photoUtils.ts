import { PhotoRecord } from '../types/sake';

export const MAX_PHOTO_COUNT = 10;
export const MAX_IMAGE_DIMENSION = 1600;
export const JPEG_QUALITY = 0.82;

/**
 * 画像のリサイズ寸法を計算する純粋関数
 *
 * 要件:
 * - 長辺が maxDim (1600px) を超える場合のみ、アスペクト比を維持して長辺が maxDim になるよう縮小する
 * - maxDim 以下の場合は拡大せず元の寸法を維持する
 * - 端数は四捨五入する
 */
export function calculateResizedDimensions(
  origW: number,
  origH: number,
  maxDim: number = MAX_IMAGE_DIMENSION
): { width: number; height: number } {
  if (origW <= 0 || origH <= 0 || maxDim <= 0) {
    return { width: Math.max(1, Math.round(origW)), height: Math.max(1, Math.round(origH)) };
  }

  const longerSide = Math.max(origW, origH);
  if (longerSide <= maxDim) {
    return { width: Math.round(origW), height: Math.round(origH) };
  }

  const scale = maxDim / longerSide;
  return {
    width: Math.max(1, Math.round(origW * scale)),
    height: Math.max(1, Math.round(origH * scale)),
  };
}

/**
 * Base64 Data URL から SHA-256 ハッシュ (64桁 hex) とバイトサイズを計算する
 * Node.js (Vitest) およびブラウザ (Web Crypto API) の両環境に対応
 */
export async function computeDataUrlHashAndSize(
  dataUrl: string
): Promise<{ contentHash: string; byteSize: number }> {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('不正な Data URL です (カンマが見つかりません)');
  }

  const base64Str = dataUrl.slice(commaIdx + 1);

  // Base64 デコード
  let bytes: Uint8Array;
  if (typeof atob === 'function') {
    const binaryStr = atob(base64Str);
    bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
  } else if (typeof Buffer !== 'undefined') {
    bytes = new Uint8Array(Buffer.from(base64Str, 'base64'));
  } else {
    throw new Error('Base64 デコード環境がありません');
  }

  const byteSize = bytes.byteLength;

  // SHA-256 ハッシュ計算
  let contentHash = '';
  if (globalThis.crypto?.subtle?.digest) {
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    contentHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').toLowerCase();
  } else {
    throw new Error('Web Crypto API (crypto.subtle.digest) が利用できません');
  }

  return {
    contentHash,
    byteSize,
  };
}

/**
 * 代表写真 ID を解決する純粋関数
 *
 * ルール:
 * - 写真が0枚なら null
 * - currentPrimaryId が photoIds に含まれていればそれを維持
 * - 含まれていなければ photoIds[0] を代表写真とする
 */
export function resolveEffectivePrimaryPhotoId(
  photoIds: string[],
  currentPrimaryId?: string | null
): string | null {
  if (photoIds.length === 0) {
    return null;
  }
  if (currentPrimaryId && photoIds.includes(currentPrimaryId)) {
    return currentPrimaryId;
  }
  return photoIds[0] ?? null;
}

/**
 * ドラフト写真リストに写真を追加する純粋関数
 * 1本あたり上限10枚のチェックを含む
 */
export function addPhotoToDraft(
  currentPhotoIds: string[],
  newPhotoId: string,
  currentPrimaryId?: string | null
): { photoIds: string[]; primaryPhotoId: string } {
  if (currentPhotoIds.length >= MAX_PHOTO_COUNT) {
    throw new Error(`写真は1本につき最大 ${MAX_PHOTO_COUNT} 枚までです。`);
  }

  const nextPhotoIds = [...currentPhotoIds, newPhotoId];
  const nextPrimaryId = currentPrimaryId && currentPhotoIds.includes(currentPrimaryId)
    ? currentPrimaryId
    : (nextPhotoIds[0] ?? newPhotoId);

  return {
    photoIds: nextPhotoIds,
    primaryPhotoId: nextPrimaryId,
  };
}

/**
 * ドラフト写真リストから写真を削除する純粋関数
 * 代表写真が削除された場合は残る先頭が自動昇格する
 */
export function removePhotoFromDraft(
  currentPhotoIds: string[],
  removePhotoId: string,
  currentPrimaryId?: string | null
): { photoIds: string[]; primaryPhotoId: string | null } {
  const nextPhotoIds = currentPhotoIds.filter((id) => id !== removePhotoId);
  const nextPrimaryId = resolveEffectivePrimaryPhotoId(nextPhotoIds, currentPrimaryId);

  return {
    photoIds: nextPhotoIds,
    primaryPhotoId: nextPrimaryId,
  };
}

/**
 * ドラフト写真リスト内の特定の写真を差し替える純粋関数
 * 差し替え前の写真が代表写真だった場合は新しい写真を代表に引き継ぐ
 */
export function replacePhotoInDraft(
  currentPhotoIds: string[],
  targetPhotoId: string,
  newPhotoId: string,
  currentPrimaryId?: string | null
): { photoIds: string[]; primaryPhotoId: string } {
  const nextPhotoIds = currentPhotoIds.map((id) => (id === targetPhotoId ? newPhotoId : id));
  const isTargetPrimary = currentPrimaryId === targetPhotoId || (!currentPrimaryId && currentPhotoIds[0] === targetPhotoId);

  const nextPrimaryId = isTargetPrimary
    ? newPhotoId
    : (resolveEffectivePrimaryPhotoId(nextPhotoIds, currentPrimaryId) ?? newPhotoId);

  return {
    photoIds: nextPhotoIds,
    primaryPhotoId: nextPrimaryId,
  };
}

/**
 * ブラウザ環境で画像ファイル（Blob / File）をデコードし、
 * EXIF 向き適用・リサイズ・JPEG 0.82 再エンコード（EXIF 除去）を行って PhotoRecord を生成する
 */
export async function processImageFileToPhotoRecord(
  file: Blob | File,
  bottleId: string,
  options: { nowIso?: string; photoId?: string } = {}
): Promise<PhotoRecord> {
  const photoId = options.photoId ?? crypto.randomUUID();
  const nowIso = options.nowIso ?? new Date().toISOString();

  let origWidth = 0;
  let origHeight = 0;
  let sourceImage: ImageBitmap | HTMLImageElement;

  // 1. 画像デコード（createImageBitmap を優先使用して EXIF Orientation を自動補正）
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    origWidth = bitmap.width;
    origHeight = bitmap.height;
    sourceImage = bitmap;
  } else if (typeof document !== 'undefined') {
    // HTMLImageElement フォールバック
    const img = document.createElement('img');
    const objectUrl = URL.createObjectURL(file);
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
        img.src = objectUrl;
      });
      origWidth = img.naturalWidth;
      origHeight = img.naturalHeight;
      sourceImage = img;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } else {
    throw new Error('Canvas / DOM 環境が利用できないため、画像処理を実行できません。');
  }

  // 2. リサイズ寸法の計算（長辺最大 1600px、拡大なし）
  const { width, height } = calculateResizedDimensions(origWidth, origHeight, MAX_IMAGE_DIMENSION);

  // 3. Canvas への描画と JPEG 0.82 への再エンコード（EXIF 完全除去）
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D コンテキストの取得に失敗しました');
  }

  ctx.drawImage(sourceImage, 0, 0, width, height);

  // ImageBitmap のリソース解放
  if ('close' in sourceImage && typeof sourceImage.close === 'function') {
    sourceImage.close();
  }

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

  // 4. SHA-256 ハッシュとバイトサイズの算出
  const { contentHash, byteSize } = await computeDataUrlHashAndSize(dataUrl);

  const record: PhotoRecord = {
    id: photoId,
    bottleId,
    mimeType: 'image/jpeg',
    dataUrl,
    width,
    height,
    byteSize,
    contentHash,
    driveFileId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    deleted: false,
  };

  return record;
}
