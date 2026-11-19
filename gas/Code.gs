/**
 * sake-collection GAS バックエンド (Google Apps Script)
 *
 * 設計: docs/step3-4-design.md §2, §3 / docs/audit-fixes-design.md (M2, M3, M5, D3)
 * 役割:
 * - 単一エンドポイント (doPost) による同期・バックアップサーバー
 * - 合言葉による fail-closed 認証 (定数時間比較)
 * - Google Sheets (Bottles / Photos / SyncMeta) による非破壊バッチ上書き管理
 * - Google Drive による非公開写真保存・contentHash 重複排除・ゴミ箱管理・3値エラー判定
 * - 誤接続防止ガード (appIdentifier: 'sake-collection')
 * - リクエストスキーマ検証・未来日時ガード (+24h)・大量削除ガード (MASS_DELETE_BLOCKED)
 */

var APP_IDENTIFIER = 'sake-collection';
var SCHEMA_VERSION = '1';

var BOTTLE_HEADERS = ['id', 'updatedAt', 'createdAt', 'deleted', 'name', 'category', 'status', 'recordJson'];
var PHOTO_HEADERS = ['id', 'bottleId', 'contentHash', 'driveFileId', 'updatedAt', 'createdAt', 'deleted', 'metaJson'];
var SYNC_META_HEADERS = ['key', 'value', 'updatedAt'];

var MAX_CELL_LENGTH = 49000; // Google Sheets セル文字数上限 50,000 に対する安全上限
var MAX_BOTTLES_PER_SYNC = 2000;
var MAX_PHOTO_METAS_PER_SYNC = 10000;
var MAX_DOWNLOAD_PHOTOS_PER_REQUEST = 10;
var MAX_UPLOAD_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB
var FUTURE_TIMESTAMP_SKEW_MS = 24 * 60 * 60 * 1000; // +24時間

var MASS_DELETE_MIN_EXISTING_FOR_MAJORITY = 5;
var MASS_DELETE_MIN_COUNT_FOR_MAJORITY = 5;
var MASS_DELETE_MIN_EXISTING_FOR_FULL_WIPE = 3;
var MASS_TRASH_MAX_FILES_PER_SYNC = 20;

var VALID_CATEGORIES = [
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
];
var VALID_STATUSES = ['unopened', 'opened', 'finished', 'disposed'];

var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
var HASH_HEX_REGEX = /^[0-9a-f]{64}$/i;

/**
 * HTTP POST エンドポイント
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return makeJsonResponse({
        ok: false,
        errorCode: 'BAD_REQUEST',
        message: 'リクエストボディが空です',
      });
    }

    var request;
    try {
      request = JSON.parse(e.postData.contents);
    } catch (_parseError) {
      return makeJsonResponse({
        ok: false,
        errorCode: 'BAD_REQUEST',
        message: 'リクエスト JSON の構文が不正です',
      });
    }

    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return makeJsonResponse({
        ok: false,
        errorCode: 'BAD_REQUEST',
        message: 'リクエストボディは JSON オブジェクトである必要があります',
      });
    }

    var action = request.action;

    // 1. サーバー設定 (スクリプトプロパティ) の fail-closed チェック
    var config = getServerConfig();
    if (!config.ok) {
      return makeJsonResponse(config.error);
    }

    // 2. 合言葉の定数時間比較 (fail-closed)
    if (!verifyPassphrase(request.passphrase, config.passphrase)) {
      return makeJsonResponse({
        ok: false,
        errorCode: 'UNAUTHORIZED',
        message: '認証に失敗しました（合言葉が正しくありません）',
      });
    }

    // 3. スプレッドシート取得と誤接続防止 (appIdentifier) チェック
    var ssContext = getSpreadsheetContext(config.spreadsheetId);
    if (!ssContext.ok) {
      return makeJsonResponse(ssContext.error);
    }

    // 4. Drive フォルダ取得と公開状態チェック (fail-closed)
    var driveContext = getDriveFolderContext(config.driveFolderId);
    if (!driveContext.ok) {
      return makeJsonResponse(driveContext.error);
    }

    // 5. アクション振り分け
    switch (action) {
      case 'ping':
        return handlePing(ssContext, driveContext);

      case 'sync_metadata':
        return withScriptLock(function () {
          return handleSyncMetadata(request, ssContext, driveContext);
        });

      case 'upload_photo':
        return withScriptLock(function () {
          return handleUploadPhoto(request, ssContext, driveContext);
        });

      case 'download_photos':
        return handleDownloadPhotos(request, ssContext, driveContext);

      default:
        return makeJsonResponse({
          ok: false,
          errorCode: 'UNKNOWN_ACTION',
          message: '未知のアクションです: ' + action,
        });
    }
  } catch (error) {
    return makeJsonResponse({
      ok: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'サーバー内部エラーが発生しました: ' + (error && error.message ? error.message : String(error)),
    });
  }
}

/**
 * HTTP GET エンドポイント (直接ブラウザ等で叩かれた場合の案内)
 */
function doGet() {
  return makeJsonResponse({
    ok: false,
    errorCode: 'METHOD_NOT_ALLOWED',
    message: 'sake-collection 同期 API です。POST メソッドのみ許可されています。',
  });
}

// ==========================================
// 認証・設定・排他制御ヘルパー
// ==========================================

/**
 * スクリプトプロパティの fail-closed 取得
 */
function getServerConfig() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var passphrase = props.SYNC_PASSPHRASE ? props.SYNC_PASSPHRASE.trim() : '';
  var spreadsheetId = props.SPREADSHEET_ID ? props.SPREADSHEET_ID.trim() : '';
  var driveFolderId = props.DRIVE_FOLDER_ID ? props.DRIVE_FOLDER_ID.trim() : '';

  if (!passphrase || !spreadsheetId || !driveFolderId) {
    return {
      ok: false,
      error: {
        ok: false,
        errorCode: 'CONFIG_ERROR',
        message: 'サーバー設定が不完全です（SYNC_PASSPHRASE, SPREADSHEET_ID, DRIVE_FOLDER_ID のいずれかが未設定です）',
      },
    };
  }

  return {
    ok: true,
    passphrase: passphrase,
    spreadsheetId: spreadsheetId,
    driveFolderId: driveFolderId,
  };
}

/**
 * 合言葉の定数時間比較 (Timing Attack 対策)
 */
function verifyPassphrase(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') {
    return false;
  }
  if (input.length === 0 || expected.length === 0) {
    return false;
  }
  if (input.length !== expected.length) {
    return false;
  }
  var diff = 0;
  for (var i = 0; i < input.length; i++) {
    diff |= input.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 排他制御 (LockService) ラッパー
 */
function withScriptLock(fn) {
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(25000);
  if (!acquired) {
    return makeJsonResponse({
      ok: false,
      errorCode: 'LOCK_TIMEOUT',
      message: '他の同期処理が実行中のためタイムアウトしました。しばらく待ってから再試行してください。',
    });
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * JSON レスポンス生成
 */
function makeJsonResponse(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ==========================================
// 入力検証・日時チェックヘルパー (M5)
// ==========================================

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function isValidIsoUtc(val) {
  if (typeof val !== 'string' || !ISO_DATE_REGEX.test(val)) {
    return false;
  }
  return !isNaN(Date.parse(val));
}

function makePayloadError(errorCode, message) {
  return {
    ok: false,
    error: {
      ok: false,
      errorCode: errorCode,
      message: message,
    },
  };
}

function validateBottlePayload(b, index, maxAllowedFutureMs) {
  var prefix = 'bottles[' + index + ']';
  if (!isPlainObject(b)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + ' がオブジェクトではありません');
  }
  if (typeof b.id !== 'string' || !UUID_REGEX.test(b.id)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.id が UUID 形式ではありません');
  }
  if (typeof b.name !== 'string' || b.name.trim().length === 0) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.name は空にできません');
  }
  if (typeof b.category !== 'string' || VALID_CATEGORIES.indexOf(b.category) === -1) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.category が不正です: ' + String(b.category));
  }
  if (typeof b.status !== 'string' || VALID_STATUSES.indexOf(b.status) === -1) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.status が不正です: ' + String(b.status));
  }
  if (!isValidIsoUtc(b.createdAt)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.createdAt が ISO 8601 UTC 日時ではありません');
  }
  if (!isValidIsoUtc(b.updatedAt)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.updatedAt が ISO 8601 UTC 日時ではありません');
  }
  if (Date.parse(b.createdAt) > maxAllowedFutureMs || Date.parse(b.updatedAt) > maxAllowedFutureMs) {
    return makePayloadError(
      'INVALID_TIMESTAMP',
      prefix + ' にサーバー時刻より24時間以上未来の日時が指定されているため拒否しました'
    );
  }
  if (typeof b.deleted !== 'boolean') {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.deleted は真偽値である必要があります');
  }
  if (!Array.isArray(b.photoIds)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.photoIds は配列である必要があります');
  }
  for (var i = 0; i < b.photoIds.length; i++) {
    if (typeof b.photoIds[i] !== 'string' || !UUID_REGEX.test(b.photoIds[i])) {
      return makePayloadError('INVALID_PAYLOAD', prefix + '.photoIds[' + i + '] が UUID 形式ではありません');
    }
  }
  if (
    b.primaryPhotoId !== null &&
    b.primaryPhotoId !== undefined &&
    (typeof b.primaryPhotoId !== 'string' || !UUID_REGEX.test(b.primaryPhotoId))
  ) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.primaryPhotoId が不正です');
  }
  return { ok: true };
}

function validatePhotoMetaPayload(p, fieldName, index, maxAllowedFutureMs) {
  var prefix = fieldName + '[' + index + ']';
  if (!isPlainObject(p)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + ' がオブジェクトではありません');
  }
  if (typeof p.id !== 'string' || !UUID_REGEX.test(p.id)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.id が UUID 形式ではありません');
  }
  if (typeof p.bottleId !== 'string' || !UUID_REGEX.test(p.bottleId)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.bottleId が UUID 形式ではありません');
  }
  if (p.mimeType !== 'image/jpeg' && p.mimeType !== 'image/webp') {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.mimeType が不正です');
  }
  if (typeof p.contentHash !== 'string' || !HASH_HEX_REGEX.test(p.contentHash)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.contentHash が64桁の16進数ではありません');
  }
  if (
    p.driveFileId !== null &&
    p.driveFileId !== undefined &&
    (typeof p.driveFileId !== 'string' || p.driveFileId.trim().length === 0)
  ) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.driveFileId が不正です');
  }
  if (!isValidIsoUtc(p.createdAt)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.createdAt が ISO 8601 UTC 日時ではありません');
  }
  if (!isValidIsoUtc(p.updatedAt)) {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.updatedAt が ISO 8601 UTC 日時ではありません');
  }
  if (Date.parse(p.createdAt) > maxAllowedFutureMs || Date.parse(p.updatedAt) > maxAllowedFutureMs) {
    return makePayloadError(
      'INVALID_TIMESTAMP',
      prefix + ' にサーバー時刻より24時間以上未来の日時が指定されているため拒否しました'
    );
  }
  if (typeof p.deleted !== 'boolean') {
    return makePayloadError('INVALID_PAYLOAD', prefix + '.deleted は真偽値である必要があります');
  }
  return { ok: true };
}

function validateSyncMetadataRequest(request, nowMs) {
  if (!Array.isArray(request.bottles)) {
    return makePayloadError('INVALID_PAYLOAD', 'bottles は配列である必要があります');
  }
  if (!Array.isArray(request.photoMetas)) {
    return makePayloadError('INVALID_PAYLOAD', 'photoMetas は配列である必要があります');
  }
  if (request.pendingDeletedPhotos !== undefined && !Array.isArray(request.pendingDeletedPhotos)) {
    return makePayloadError('INVALID_PAYLOAD', 'pendingDeletedPhotos は配列である必要があります');
  }

  var pendingDeletedPhotos = request.pendingDeletedPhotos || [];
  if (request.bottles.length > MAX_BOTTLES_PER_SYNC) {
    return makePayloadError(
      'INVALID_PAYLOAD',
      '1回の同期で送信できるボトル件数の上限（' + MAX_BOTTLES_PER_SYNC + '件）を超えています'
    );
  }
  if (request.photoMetas.length > MAX_PHOTO_METAS_PER_SYNC || pendingDeletedPhotos.length > MAX_PHOTO_METAS_PER_SYNC) {
    return makePayloadError(
      'INVALID_PAYLOAD',
      '1回の同期で送信できる写真メタ件数の上限（' + MAX_PHOTO_METAS_PER_SYNC + '件）を超えています'
    );
  }

  var maxAllowedFutureMs = nowMs + FUTURE_TIMESTAMP_SKEW_MS;

  for (var i = 0; i < request.bottles.length; i++) {
    var bRes = validateBottlePayload(request.bottles[i], i, maxAllowedFutureMs);
    if (!bRes.ok) {
      return bRes;
    }
  }

  for (var j = 0; j < request.photoMetas.length; j++) {
    var pRes = validatePhotoMetaPayload(request.photoMetas[j], 'photoMetas', j, maxAllowedFutureMs);
    if (!pRes.ok) {
      return pRes;
    }
  }

  for (var k = 0; k < pendingDeletedPhotos.length; k++) {
    var pdRes = validatePhotoMetaPayload(pendingDeletedPhotos[k], 'pendingDeletedPhotos', k, maxAllowedFutureMs);
    if (!pdRes.ok) {
      return pdRes;
    }
  }

  return { ok: true };
}

function validateUploadPhotoRequest(request, nowMs) {
  var photo = request.photo;
  if (!isPlainObject(photo)) {
    return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真ペイロードが不正です（photo オブジェクトが必要です）');
  }
  if (typeof photo.id !== 'string' || !UUID_REGEX.test(photo.id)) {
    return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真 ID が UUID 形式ではありません');
  }
  if (typeof photo.bottleId !== 'string' || !UUID_REGEX.test(photo.bottleId)) {
    return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真の bottleId が UUID 形式ではありません');
  }
  if (typeof photo.contentHash !== 'string' || !HASH_HEX_REGEX.test(photo.contentHash)) {
    return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真の contentHash が64桁の16進数ではありません');
  }
  if (photo.mimeType !== undefined && photo.mimeType !== 'image/jpeg' && photo.mimeType !== 'image/webp') {
    return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真の mimeType は image/jpeg または image/webp のみ許可されています');
  }

  var maxAllowedFutureMs = nowMs + FUTURE_TIMESTAMP_SKEW_MS;
  if (photo.createdAt !== undefined) {
    if (!isValidIsoUtc(photo.createdAt)) {
      return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真の createdAt が ISO 8601 UTC 日時ではありません');
    }
    if (Date.parse(photo.createdAt) > maxAllowedFutureMs) {
      return makePayloadError('INVALID_TIMESTAMP', '写真の createdAt が未来すぎるため拒否しました');
    }
  }
  if (photo.updatedAt !== undefined) {
    if (!isValidIsoUtc(photo.updatedAt)) {
      return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真の updatedAt が ISO 8601 UTC 日時ではありません');
    }
    if (Date.parse(photo.updatedAt) > maxAllowedFutureMs) {
      return makePayloadError('INVALID_TIMESTAMP', '写真の updatedAt が未来すぎるため拒否しました');
    }
  }

  if (typeof photo.dataUrl !== 'string') {
    return makePayloadError('INVALID_PHOTO_PAYLOAD', '写真ペイロードに dataUrl が含まれていません');
  }
  var matches = photo.dataUrl.match(/^data:(image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!matches || !matches[1] || !matches[2]) {
    return makePayloadError(
      'INVALID_DATA_URL',
      'dataUrl の形式が不正です (data:image/jpeg;base64,... または data:image/webp;base64,... が必要です)'
    );
  }
  if (photo.mimeType && photo.mimeType !== matches[1]) {
    return makePayloadError('INVALID_DATA_URL', 'mimeType と dataUrl のメディア種別が一致しません');
  }

  var decodedBytes = Utilities.base64Decode(matches[2]);
  if (!decodedBytes || decodedBytes.length === 0) {
    return makePayloadError('INVALID_DATA_URL', '画像データが空です');
  }
  if (decodedBytes.length > MAX_UPLOAD_PHOTO_BYTES) {
    return makePayloadError(
      'INVALID_PHOTO_PAYLOAD',
      '写真サイズが上限（5MB）を超えているため拒否しました'
    );
  }

  return {
    ok: true,
    mimeType: matches[1],
    decodedBytes: decodedBytes,
  };
}

function validateDownloadPhotosRequest(request) {
  if (!Array.isArray(request.photoIds)) {
    return makePayloadError('INVALID_PAYLOAD', 'photoIds は配列である必要があります');
  }
  if (request.photoIds.length > MAX_DOWNLOAD_PHOTOS_PER_REQUEST) {
    return makePayloadError(
      'INVALID_PAYLOAD',
      '1回でダウンロードできる写真数の上限（' + MAX_DOWNLOAD_PHOTOS_PER_REQUEST + '枚）を超えています'
    );
  }
  for (var i = 0; i < request.photoIds.length; i++) {
    if (typeof request.photoIds[i] !== 'string' || !UUID_REGEX.test(request.photoIds[i])) {
      return makePayloadError('INVALID_PAYLOAD', 'photoIds[' + i + '] が UUID 形式ではありません');
    }
  }
  return { ok: true };
}

/**
 * 大量削除・全消去防止ガード (M5)
 */
function checkMassDeleteGuard(serverBottles, mergedBottles, driveTrashCount) {
  var existingActiveMap = {};
  var existingActiveCount = 0;
  for (var i = 0; i < serverBottles.length; i++) {
    var sb = serverBottles[i];
    if (sb && !sb.deleted) {
      existingActiveMap[sb.id] = true;
      existingActiveCount++;
    }
  }

  var mergedMap = {};
  var resultingActiveCount = 0;
  for (var j = 0; j < mergedBottles.length; j++) {
    var mb = mergedBottles[j];
    mergedMap[mb.id] = mb;
    if (!mb.deleted) {
      resultingActiveCount++;
    }
  }

  var newlyDeletedCount = 0;
  for (var id in existingActiveMap) {
    var after = mergedMap[id];
    if (!after || after.deleted) {
      newlyDeletedCount++;
    }
  }

  if (
    existingActiveCount >= MASS_DELETE_MIN_EXISTING_FOR_FULL_WIPE &&
    resultingActiveCount === 0
  ) {
    return makePayloadError(
      'MASS_DELETE_BLOCKED',
      '安全保護のため、既存の全ボトル（' + existingActiveCount + '本）を一度にすべて削除する同期を中止しました。'
    );
  }

  if (
    existingActiveCount >= MASS_DELETE_MIN_EXISTING_FOR_MAJORITY &&
    newlyDeletedCount >= MASS_DELETE_MIN_COUNT_FOR_MAJORITY &&
    newlyDeletedCount * 2 > existingActiveCount
  ) {
    return makePayloadError(
      'MASS_DELETE_BLOCKED',
      '安全保護のため、過半数のボトル（' + existingActiveCount + '本中 ' + newlyDeletedCount + '本）を一度に削除する同期を中止しました。'
    );
  }

  if (driveTrashCount > MASS_TRASH_MAX_FILES_PER_SYNC) {
    return makePayloadError(
      'MASS_DELETE_BLOCKED',
      '安全保護のため、1回の同期で上限（' + MASS_TRASH_MAX_FILES_PER_SYNC + '件）を超える写真ファイル（' + driveTrashCount + '件）をゴミ箱へ移動する操作を中止しました。'
    );
  }

  return { ok: true };
}

// ==========================================
// スプレッドシート・Drive 管理
// ==========================================

/**
 * スプレッドシートおよび各シートの初期化・検証・appIdentifier ガード
 */
function getSpreadsheetContext(spreadsheetId) {
  try {
    var ss = SpreadsheetApp.openById(spreadsheetId);
    var bottlesSheet = getOrCreateSheet(ss, 'Bottles', BOTTLE_HEADERS);
    var photosSheet = getOrCreateSheet(ss, 'Photos', PHOTO_HEADERS);
    var syncMetaSheet = getOrCreateSheet(ss, 'SyncMeta', SYNC_META_HEADERS);

    // appIdentifier と schemaVersion の整合性チェック (誤接続防止ハードストップ)
    var metaValues = syncMetaSheet.getDataRange().getValues();
    var metaMap = {};
    for (var i = 1; i < metaValues.length; i++) {
      var k = String(metaValues[i][0]).trim();
      var v = String(metaValues[i][1]).trim();
      if (k) {
        metaMap[k] = { rowIndex: i + 1, value: v };
      }
    }

    var nowIso = new Date().toISOString();

    if (metaMap.appIdentifier) {
      if (metaMap.appIdentifier.value !== APP_IDENTIFIER) {
        return {
          ok: false,
          error: {
            ok: false,
            errorCode: 'INVALID_APP_IDENTIFIER',
            message: '指定されたスプレッドシートは別アプリのものです (appIdentifier: ' + metaMap.appIdentifier.value + ')',
          },
        };
      }
    } else {
      syncMetaSheet.appendRow(['appIdentifier', APP_IDENTIFIER, nowIso]);
    }

    if (!metaMap.schemaVersion) {
      syncMetaSheet.appendRow(['schemaVersion', SCHEMA_VERSION, nowIso]);
    }

    return {
      ok: true,
      spreadsheet: ss,
      bottlesSheet: bottlesSheet,
      photosSheet: photosSheet,
      syncMetaSheet: syncMetaSheet,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        ok: false,
        errorCode: 'SPREADSHEET_ACCESS_ERROR',
        message: 'スプレッドシートへのアクセスに失敗しました: ' + (error && error.message ? error.message : String(error)),
      },
    };
  }
}

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Drive フォルダの取得と公開状態チェック (fail-closed)
 */
function getDriveFolderContext(folderId) {
  try {
    var folder = DriveApp.getFolderById(folderId);

    // 共有範囲の安全検査 (ANYONE または ANYONE_WITH_LINK は拒否)
    var access = folder.getSharingAccess();
    if (access === DriveApp.Access.ANYONE || access === DriveApp.Access.ANYONE_WITH_LINK) {
      return {
        ok: false,
        error: {
          ok: false,
          errorCode: 'INSECURE_DRIVE_FOLDER',
          message: '写真保存先 Drive フォルダの共有範囲が公開に設定されているため処理を拒否しました',
        },
      };
    }

    return {
      ok: true,
      folder: folder,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        ok: false,
        errorCode: 'DRIVE_FOLDER_ACCESS_ERROR',
        message: 'Drive フォルダへのアクセスに失敗しました: ' + (error && error.message ? error.message : String(error)),
      },
    };
  }
}

function makeDriveTemporaryError(error) {
  var detail = error && error.message ? error.message : String(error || '');
  return {
    ok: false,
    errorCode: 'DRIVE_TEMPORARY_ERROR',
    message: 'Google Drive への一時的なアクセスエラーが発生しました。少し時間をおいて再度お試しください。' +
      (detail ? ' (' + detail + ')' : ''),
  };
}

function isExplicitDriveNotFoundError(error) {
  var msg = error && error.message ? String(error.message) : String(error || '');
  return /No item with the given ID could be found|File not found|Item not found|指定された.*見つかりません/i.test(msg);
}

/**
 * フォルダ内の有効（非ゴミ箱）ファイル ID 集合を一括取得する
 */
function buildActiveDriveFolderFileSet(folder) {
  try {
    var activeSet = {};
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (!file.isTrashed()) {
        activeSet[file.getId()] = true;
      }
    }
    return { ok: true, activeSet: activeSet };
  } catch (error) {
    return {
      ok: false,
      error: makeDriveTemporaryError(error),
    };
  }
}

/**
 * Drive ファイルの状態を 3値 ('active' | 'missing' | 'error') で判定する (M3)
 */
function checkDriveFileStatus(fileId, activeFolderFileSet) {
  if (!fileId || typeof fileId !== 'string') {
    return { status: 'missing' };
  }
  if (activeFolderFileSet && activeFolderFileSet[fileId] === true) {
    return { status: 'active' };
  }
  try {
    var file = DriveApp.getFileById(fileId);
    if (file.isTrashed()) {
      return { status: 'missing' };
    }
    return { status: 'active' };
  } catch (error) {
    if (isExplicitDriveNotFoundError(error)) {
      return { status: 'missing' };
    }
    return {
      status: 'error',
      error: makeDriveTemporaryError(error),
    };
  }
}

// ==========================================
// シートデータ読み書き (M2: fail-closed & 非破壊上書き)
// ==========================================

function isSheetRowEmpty(row) {
  if (!row) return true;
  for (var i = 0; i < row.length; i++) {
    var cell = row[i];
    if (cell !== '' && cell !== null && cell !== undefined) {
      return false;
    }
  }
  return true;
}

function readServerRecords(sheet, sheetLabel) {
  var values = sheet.getDataRange().getValues();
  var list = [];
  var rowIndexById = {};

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (isSheetRowEmpty(row)) {
      continue;
    }
    var jsonStr = row[7];
    if (typeof jsonStr !== 'string' || jsonStr.trim().length === 0) {
      return {
        ok: false,
        error: {
          ok: false,
          errorCode: 'CORRUPTED_SHEET_DATA',
          message: 'シート（' + sheetLabel + '）の ' + (i + 1) + ' 行目の JSON 列が空のため処理を中止しました',
        },
      };
    }

    var record;
    try {
      record = JSON.parse(jsonStr);
    } catch (_e) {
      return {
        ok: false,
        error: {
          ok: false,
          errorCode: 'CORRUPTED_SHEET_DATA',
          message: 'シート（' + sheetLabel + '）の ' + (i + 1) + ' 行目の JSON が破損しているため処理を中止しました',
        },
      };
    }

    if (!isPlainObject(record) || typeof record.id !== 'string' || record.id.trim().length === 0) {
      return {
        ok: false,
        error: {
          ok: false,
          errorCode: 'CORRUPTED_SHEET_DATA',
          message: 'シート（' + sheetLabel + '）の ' + (i + 1) + ' 行目のレコード形式が不正なため処理を中止しました',
        },
      };
    }

    list.push(record);
    rowIndexById[record.id] = i + 1;
  }

  return {
    ok: true,
    records: list,
    rowIndexById: rowIndexById,
  };
}

function readServerBottles(bottlesSheet) {
  return readServerRecords(bottlesSheet, 'Bottles');
}

function readServerPhotoMetas(photosSheet) {
  return readServerRecords(photosSheet, 'Photos');
}

function buildBottleRow(b) {
  return [
    b.id,
    b.updatedAt,
    b.createdAt,
    b.deleted === true,
    b.name || '',
    b.category || '',
    b.status || '',
    JSON.stringify(b),
  ];
}

function buildPhotoRow(p) {
  return [
    p.id,
    p.bottleId,
    p.contentHash,
    p.driveFileId || '',
    p.updatedAt,
    p.createdAt,
    p.deleted === true,
    JSON.stringify(p),
  ];
}

function validateRowsCellLength(allRows, sheetLabel) {
  for (var r = 0; r < allRows.length; r++) {
    var row = allRows[r];
    for (var c = 0; c < row.length; c++) {
      var cell = row[c];
      if (typeof cell === 'string' && cell.length > MAX_CELL_LENGTH) {
        return {
          ok: false,
          error: {
            ok: false,
            errorCode: 'RECORD_TOO_LARGE',
            message: 'シート（' + sheetLabel + '）の保存データがセル文字数上限（' + MAX_CELL_LENGTH + '文字）を超えています',
          },
        };
      }
    }
  }
  return { ok: true };
}

/**
 * clearContents() を使わず、単一の setValues で上書きし、余剰末尾行のみ事後クリアする (M2)
 */
function writeSheetRowsSafely(sheet, headers, rows, sheetLabel) {
  var allRows = [headers].concat(rows);
  var lengthCheck = validateRowsCellLength(allRows, sheetLabel);
  if (!lengthCheck.ok) {
    return lengthCheck;
  }

  var prevLastRow = sheet.getLastRow();
  var prevLastCol = sheet.getLastColumn();

  sheet.getRange(1, 1, allRows.length, headers.length).setValues(allRows);
  sheet.setFrozenRows(1);

  if (prevLastRow > allRows.length) {
    var clearCols = Math.max(headers.length, prevLastCol);
    sheet.getRange(allRows.length + 1, 1, prevLastRow - allRows.length, clearCols).clearContent();
  }

  return { ok: true };
}

function upsertServerPhotoMeta(photosSheet, photoMeta, existingRowIndex) {
  var row = buildPhotoRow(photoMeta);
  var lengthCheck = validateRowsCellLength([row], 'Photos');
  if (!lengthCheck.ok) {
    return lengthCheck;
  }

  if (existingRowIndex && existingRowIndex >= 2) {
    photosSheet.getRange(existingRowIndex, 1, 1, PHOTO_HEADERS.length).setValues([row]);
  } else {
    photosSheet.appendRow(row);
  }
  return { ok: true };
}

function updateLastSyncedAt(syncMetaSheet, isoString) {
  var values = syncMetaSheet.getDataRange().getValues();
  var foundRow = -1;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === 'lastSyncedAt') {
      foundRow = i + 1;
      break;
    }
  }
  if (foundRow !== -1) {
    syncMetaSheet.getRange(foundRow, 2, 1, 2).setValues([[isoString, isoString]]);
  } else {
    syncMetaSheet.appendRow(['lastSyncedAt', isoString, isoString]);
  }
}

function getLastSyncedAt(syncMetaSheet) {
  var values = syncMetaSheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === 'lastSyncedAt') {
      return String(values[i][1]).trim() || null;
    }
  }
  return null;
}

// ==========================================
// アクションハンドラー
// ==========================================

/**
 * 1. ping アクション
 */
function handlePing(ssContext, _driveContext) {
  var bottlesRes = readServerBottles(ssContext.bottlesSheet);
  if (!bottlesRes.ok) {
    return makeJsonResponse(bottlesRes.error);
  }
  var photosRes = readServerPhotoMetas(ssContext.photosSheet);
  if (!photosRes.ok) {
    return makeJsonResponse(photosRes.error);
  }

  var bottles = bottlesRes.records;
  var photos = photosRes.records;

  var bottlesActive = bottles.filter(function (b) { return !b.deleted; }).length;
  var photosActive = photos.filter(function (p) { return !p.deleted; }).length;
  var lastSyncedAt = getLastSyncedAt(ssContext.syncMetaSheet);

  return makeJsonResponse({
    ok: true,
    appIdentifier: APP_IDENTIFIER,
    serverTime: new Date().toISOString(),
    counts: {
      bottlesTotal: bottles.length,
      bottlesActive: bottlesActive,
      photosTotal: photos.length,
      photosActive: photosActive,
    },
    lastSyncedAt: lastSyncedAt,
  });
}

/**
 * 2. sync_metadata アクション
 */
function handleSyncMetadata(request, ssContext, driveContext) {
  var nowMs = Date.now();
  var nowIso = new Date(nowMs).toISOString();

  // 1. ペイロードスキーマ・未来日時検証 (M5)
  var reqVal = validateSyncMetadataRequest(request, nowMs);
  if (!reqVal.ok) {
    return makeJsonResponse(reqVal.error);
  }

  var clientBottles = request.bottles;
  var clientPhotoMetas = request.photoMetas;
  var pendingDeletedPhotos = Array.isArray(request.pendingDeletedPhotos) ? request.pendingDeletedPhotos : [];
  var isInitialEmptyClient = Boolean(request.isInitialEmptyClient);

  // 2. サーバー側シート読込 (M2: 破損行は fail-closed)
  var serverBottlesRes = readServerBottles(ssContext.bottlesSheet);
  if (!serverBottlesRes.ok) {
    return makeJsonResponse(serverBottlesRes.error);
  }
  var serverPhotoMetasRes = readServerPhotoMetas(ssContext.photosSheet);
  if (!serverPhotoMetasRes.ok) {
    return makeJsonResponse(serverPhotoMetasRes.error);
  }

  var serverBottles = serverBottlesRes.records;
  var serverPhotoMetas = serverPhotoMetasRes.records;

  // A. ボトルの LWW マージ (空端末保護対応)
  var mergedBottles = [];
  if (isInitialEmptyClient) {
    mergedBottles = serverBottles.slice();
  } else {
    var serverBottleMap = {};
    serverBottles.forEach(function (b) { serverBottleMap[b.id] = b; });
    var clientBottleMap = {};
    clientBottles.forEach(function (b) { clientBottleMap[b.id] = b; });

    var allBottleIds = {};
    serverBottles.forEach(function (b) { allBottleIds[b.id] = true; });
    clientBottles.forEach(function (b) { allBottleIds[b.id] = true; });

    for (var bId in allBottleIds) {
      var sRec = serverBottleMap[bId];
      var cRec = clientBottleMap[bId];
      if (sRec && cRec) {
        if (cRec.updatedAt > sRec.updatedAt) {
          mergedBottles.push(cRec);
        } else if (sRec.updatedAt > cRec.updatedAt) {
          mergedBottles.push(sRec);
        } else {
          // 同一刻時タイブレーク: deleted === true 優先、さらに同一ならサーバー側維持
          if (cRec.deleted && !sRec.deleted) {
            mergedBottles.push(cRec);
          } else {
            mergedBottles.push(sRec);
          }
        }
      } else if (sRec) {
        mergedBottles.push(sRec);
      } else if (cRec) {
        mergedBottles.push(cRec);
      }
    }
  }

  mergedBottles.sort(function (a, b) { return a.id.localeCompare(b.id); });
  var bottleMap = {};
  mergedBottles.forEach(function (b) { bottleMap[b.id] = b; });

  // B. 写真メタデータの LWW マージ (pendingDeletedPhotos も合流)
  var rawMergedPhotoMetas = [];
  if (isInitialEmptyClient) {
    rawMergedPhotoMetas = serverPhotoMetas.slice();
  } else {
    var serverPhotoMap = {};
    serverPhotoMetas.forEach(function (p) { serverPhotoMap[p.id] = p; });
    var clientPhotoMap = {};
    clientPhotoMetas.forEach(function (p) { clientPhotoMap[p.id] = p; });
    pendingDeletedPhotos.forEach(function (pd) {
      var existing = clientPhotoMap[pd.id];
      if (!existing || pd.updatedAt >= existing.updatedAt) {
        clientPhotoMap[pd.id] = pd;
      }
    });

    var allPhotoIds = {};
    serverPhotoMetas.forEach(function (p) { allPhotoIds[p.id] = true; });
    for (var cpId in clientPhotoMap) {
      allPhotoIds[cpId] = true;
    }

    for (var pId in allPhotoIds) {
      var sPhoto = serverPhotoMap[pId];
      var cPhoto = clientPhotoMap[pId];
      if (sPhoto && cPhoto) {
        var driveFileId = sPhoto.driveFileId || cPhoto.driveFileId || null;
        var winning = null;
        if (cPhoto.updatedAt > sPhoto.updatedAt) {
          winning = cPhoto;
        } else if (sPhoto.updatedAt > cPhoto.updatedAt) {
          winning = sPhoto;
        } else {
          if (cPhoto.deleted && !sPhoto.deleted) {
            winning = cPhoto;
          } else {
            winning = sPhoto;
          }
        }
        var merged = Object.assign({}, winning, { driveFileId: driveFileId });
        rawMergedPhotoMetas.push(merged);
      } else if (sPhoto) {
        rawMergedPhotoMetas.push(Object.assign({}, sPhoto));
      } else if (cPhoto) {
        rawMergedPhotoMetas.push(Object.assign({}, cPhoto));
      }
    }
  }

  // C. 親ボトル photoIds による正規化
  // ケースA: parentBottle が存在し、photoIds に含まれる -> parentBottle.deleted
  // ケースB: parentBottle が存在しない、または photoIds に含まれない -> deleted = true
  var reconciledPhotoMetas = [];
  for (var i = 0; i < rawMergedPhotoMetas.length; i++) {
    var meta = rawMergedPhotoMetas[i];
    var parent = bottleMap[meta.bottleId];
    var isDeleted = true;
    if (parent && Array.isArray(parent.photoIds) && parent.photoIds.indexOf(meta.id) !== -1) {
      isDeleted = parent.deleted === true;
    }
    reconciledPhotoMetas.push(Object.assign({}, meta, { deleted: isDeleted }));
  }

  // D. Drive 上の 3値状態確認と重複排除マップの構築 (M3: 一時エラー時は driveFileId を消さず安全停止)
  var hasAnyDriveId = reconciledPhotoMetas.some(function (p) { return Boolean(p.driveFileId); });
  var activeFolderFileSet = null;
  if (hasAnyDriveId) {
    var folderFilesRes = buildActiveDriveFolderFileSet(driveContext.folder);
    if (!folderFilesRes.ok) {
      return makeJsonResponse(folderFilesRes.error);
    }
    activeFolderFileSet = folderFilesRes.activeSet;
  }

  var activeDriveIdCache = {}; // driveFileId -> 'active' | 'missing'
  var knownHashToDriveId = {}; // contentHash -> driveFileId

  for (var j = 0; j < reconciledPhotoMetas.length; j++) {
    var pMeta = reconciledPhotoMetas[j];
    if (pMeta.driveFileId) {
      var cachedStatus = activeDriveIdCache[pMeta.driveFileId];
      if (!cachedStatus) {
        var statusRes = checkDriveFileStatus(pMeta.driveFileId, activeFolderFileSet);
        if (statusRes.status === 'error') {
          return makeJsonResponse(statusRes.error);
        }
        cachedStatus = statusRes.status;
        activeDriveIdCache[pMeta.driveFileId] = cachedStatus;
      }
      if (cachedStatus === 'missing') {
        // Drive 上でゴミ箱入りまたは明確に不存在のファイル ID のみクリア
        pMeta.driveFileId = null;
      } else if (!pMeta.deleted && pMeta.contentHash) {
        // 有効な写真のみ重複排除マップに登録
        knownHashToDriveId[pMeta.contentHash] = pMeta.driveFileId;
      }
    }
  }

  // 重複排除適用: driveFileId が未確定の有効な写真で、同一 contentHash の有効 driveFileId があれば再利用
  for (var k = 0; k < reconciledPhotoMetas.length; k++) {
    var target = reconciledPhotoMetas[k];
    if (!target.deleted && !target.driveFileId && target.contentHash && knownHashToDriveId[target.contentHash]) {
      target.driveFileId = knownHashToDriveId[target.contentHash];
    }
  }

  // E. 孤立した Drive ファイルの特定（この時点ではまだゴミ箱へ移動しない）
  var activeDriveIdsInUse = {};
  reconciledPhotoMetas.forEach(function (p) {
    if (!p.deleted && p.driveFileId) {
      activeDriveIdsInUse[p.driveFileId] = true;
    }
  });

  var driveIdsToTrash = [];
  var driveIdsToTrashSeen = {};
  reconciledPhotoMetas.forEach(function (p) {
    if (
      p.deleted &&
      p.driveFileId &&
      !activeDriveIdsInUse[p.driveFileId] &&
      !driveIdsToTrashSeen[p.driveFileId]
    ) {
      driveIdsToTrashSeen[p.driveFileId] = true;
      driveIdsToTrash.push(p.driveFileId);
    }
  });

  // F. 大量削除・全消去防止ガード (M5: シート書込・Drive ゴミ箱移動より前に検査)
  var massDeleteRes = checkMassDeleteGuard(serverBottles, mergedBottles, driveIdsToTrash.length);
  if (!massDeleteRes.ok) {
    return makeJsonResponse(massDeleteRes.error);
  }

  // G. アップロードが必要な写真 ID リスト (photosToUpload) の算出
  var photosToUpload = [];
  reconciledPhotoMetas.forEach(function (p) {
    if (!p.deleted && !p.driveFileId) {
      photosToUpload.push(p.id);
    }
  });

  reconciledPhotoMetas.sort(function (a, b) { return a.id.localeCompare(b.id); });

  // H. 削除済みボトルのトームストーン正規化 (updatedAt は維持したまま photoIds: [], primaryPhotoId: null)
  var sanitizedBottles = mergedBottles.map(function (b) {
    if (b.deleted) {
      return Object.assign({}, b, {
        photoIds: [],
        primaryPhotoId: null,
      });
    }
    return b;
  });

  // I. シート書き込みの事前セル長検証 (両シート書込前に検証)
  var bottleRows = sanitizedBottles.map(buildBottleRow);
  var photoRows = reconciledPhotoMetas.map(buildPhotoRow);
  var bottleLenCheck = validateRowsCellLength([BOTTLE_HEADERS].concat(bottleRows), 'Bottles');
  if (!bottleLenCheck.ok) {
    return makeJsonResponse(bottleLenCheck.error);
  }
  var photoLenCheck = validateRowsCellLength([PHOTO_HEADERS].concat(photoRows), 'Photos');
  if (!photoLenCheck.ok) {
    return makeJsonResponse(photoLenCheck.error);
  }

  // J. シート非破壊一括上書き (M2)
  var writeBottlesRes = writeSheetRowsSafely(ssContext.bottlesSheet, BOTTLE_HEADERS, bottleRows, 'Bottles');
  if (!writeBottlesRes.ok) {
    return makeJsonResponse(writeBottlesRes.error);
  }
  var writePhotosRes = writeSheetRowsSafely(ssContext.photosSheet, PHOTO_HEADERS, photoRows, 'Photos');
  if (!writePhotosRes.ok) {
    return makeJsonResponse(writePhotosRes.error);
  }
  updateLastSyncedAt(ssContext.syncMetaSheet, nowIso);

  // K. シート確定後に孤立した Drive ファイルをゴミ箱へ移動 (setTrashed(true))
  driveIdsToTrash.forEach(function (fileId) {
    try {
      var fileToTrash = DriveApp.getFileById(fileId);
      if (!fileToTrash.isTrashed()) {
        fileToTrash.setTrashed(true);
      }
    } catch (_e) {
      // 既にゴミ箱にあるか削除済みの場合はスキップ
    }
  });

  return makeJsonResponse({
    ok: true,
    bottles: sanitizedBottles,
    photoMetas: reconciledPhotoMetas,
    photosToUpload: photosToUpload,
    syncedAt: nowIso,
  });
}

/**
 * 3. upload_photo アクション
 */
function handleUploadPhoto(request, ssContext, driveContext) {
  var nowMs = Date.now();
  var nowIso = new Date(nowMs).toISOString();

  var valRes = validateUploadPhotoRequest(request, nowMs);
  if (!valRes.ok) {
    return makeJsonResponse(valRes.error);
  }

  var photo = request.photo;
  var photosRes = readServerPhotoMetas(ssContext.photosSheet);
  if (!photosRes.ok) {
    return makeJsonResponse(photosRes.error);
  }

  var photos = photosRes.records;
  var rowIndexById = photosRes.rowIndexById;

  // A. contentHash 重複排除: 既存の有効かつ trashed でないファイルを検索 (M3: 3値判定)
  var deduplicatedDriveId = null;
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    if (p.contentHash === photo.contentHash && p.driveFileId && !p.deleted) {
      var dupCheck = checkDriveFileStatus(p.driveFileId, null);
      if (dupCheck.status === 'error') {
        return makeJsonResponse(dupCheck.error);
      }
      if (dupCheck.status === 'active') {
        deduplicatedDriveId = p.driveFileId;
        break;
      }
    }
  }

  var finalDriveFileId = deduplicatedDriveId;
  var isDeduplicated = Boolean(deduplicatedDriveId);

  // B. 重複排除できなければ Drive に新規作成
  if (!finalDriveFileId) {
    var mimeType = valRes.mimeType;
    var ext = mimeType.indexOf('webp') !== -1 ? 'webp' : 'jpg';
    var fileName = 'sake-photo-' + photo.contentHash.slice(0, 12) + '-' + photo.id + '.' + ext;

    var blob = Utilities.newBlob(valRes.decodedBytes, mimeType, fileName);
    var createdFile = driveContext.folder.createFile(blob);
    finalDriveFileId = createdFile.getId();
  }

  // C. Photos シートのレコードを単一行更新または追記 (M2: シート全消し禁止)
  var targetMeta = null;
  var existingRowIndex = rowIndexById[photo.id];
  for (var j = 0; j < photos.length; j++) {
    if (photos[j].id === photo.id) {
      targetMeta = Object.assign({}, photos[j], {
        driveFileId: finalDriveFileId,
        updatedAt: nowIso,
      });
      break;
    }
  }

  if (!targetMeta) {
    targetMeta = {
      id: photo.id,
      bottleId: photo.bottleId,
      mimeType: valRes.mimeType,
      width: photo.width || 0,
      height: photo.height || 0,
      byteSize: photo.byteSize || 0,
      contentHash: photo.contentHash,
      driveFileId: finalDriveFileId,
      createdAt: photo.createdAt || nowIso,
      updatedAt: nowIso,
      deleted: photo.deleted === true,
    };
  }

  var upsertRes = upsertServerPhotoMeta(ssContext.photosSheet, targetMeta, existingRowIndex);
  if (!upsertRes.ok) {
    return makeJsonResponse(upsertRes.error);
  }
  updateLastSyncedAt(ssContext.syncMetaSheet, nowIso);

  return makeJsonResponse({
    ok: true,
    photoId: photo.id,
    driveFileId: finalDriveFileId,
    deduplicated: isDeduplicated,
  });
}

/**
 * 4. download_photos アクション
 */
function handleDownloadPhotos(request, ssContext, _driveContext) {
  var reqVal = validateDownloadPhotosRequest(request);
  if (!reqVal.ok) {
    return makeJsonResponse(reqVal.error);
  }

  var photoIds = request.photoIds;
  if (photoIds.length === 0) {
    return makeJsonResponse({
      ok: true,
      photos: [],
    });
  }

  var metasRes = readServerPhotoMetas(ssContext.photosSheet);
  if (!metasRes.ok) {
    return makeJsonResponse(metasRes.error);
  }

  var metas = metasRes.records;
  var metaMap = {};
  metas.forEach(function (m) { metaMap[m.id] = m; });

  var downloadedPhotos = [];
  for (var i = 0; i < photoIds.length; i++) {
    var id = photoIds[i];
    var meta = metaMap[id];
    if (meta && meta.driveFileId) {
      try {
        var file = DriveApp.getFileById(meta.driveFileId);
        if (!file.isTrashed()) {
          var blob = file.getBlob();
          var mimeType = meta.mimeType || blob.getContentType() || 'image/jpeg';
          var base64 = Utilities.base64Encode(blob.getBytes());
          var dataUrl = 'data:' + mimeType + ';base64,' + base64;

          downloadedPhotos.push({
            id: meta.id,
            bottleId: meta.bottleId,
            mimeType: mimeType,
            dataUrl: dataUrl,
            width: meta.width || 0,
            height: meta.height || 0,
            byteSize: meta.byteSize || 0,
            contentHash: meta.contentHash,
            driveFileId: meta.driveFileId,
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            deleted: meta.deleted === true,
          });
        }
      } catch (error) {
        if (!isExplicitDriveNotFoundError(error)) {
          return makeJsonResponse(makeDriveTemporaryError(error));
        }
      }
    }
  }

  return makeJsonResponse({
    ok: true,
    photos: downloadedPhotos,
  });
}
