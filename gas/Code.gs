/**
 * sake-collection GAS バックエンド (Google Apps Script)
 *
 * 設計: docs/step3-4-design.md §2, §3
 * 役割:
 * - 単一エンドポイント (doPost) による同期・バックアップサーバー
 * - 合言葉による fail-closed 認証 (定数時間比較)
 * - Google Sheets (Bottles / Photos / SyncMeta) によるメタデータ管理
 * - Google Drive による非公開写真保存・contentHash 重複排除・ゴミ箱管理
 * - 誤接続防止ガード (appIdentifier: 'sake-collection')
 */

var APP_IDENTIFIER = 'sake-collection';
var SCHEMA_VERSION = '1';

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

    var request = JSON.parse(e.postData.contents);
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
// スプレッドシート・Drive 管理
// ==========================================

/**
 * スプレッドシートおよび各シートの初期化・検証・appIdentifier ガード
 */
function getSpreadsheetContext(spreadsheetId) {
  try {
    var ss = SpreadsheetApp.openById(spreadsheetId);
    var bottlesSheet = getOrCreateSheet(ss, 'Bottles', [
      'id', 'updatedAt', 'createdAt', 'deleted', 'name', 'category', 'status', 'recordJson',
    ]);
    var photosSheet = getOrCreateSheet(ss, 'Photos', [
      'id', 'bottleId', 'contentHash', 'driveFileId', 'updatedAt', 'createdAt', 'deleted', 'metaJson',
    ]);
    var syncMetaSheet = getOrCreateSheet(ss, 'SyncMeta', [
      'key', 'value', 'updatedAt',
    ]);

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

/**
 * Drive ファイルが存在し、ゴミ箱 (trashed) に入っていないか検証する
 */
function isDriveFileActive(fileId) {
  if (!fileId || typeof fileId !== 'string') {
    return false;
  }
  try {
    var file = DriveApp.getFileById(fileId);
    return !file.isTrashed();
  } catch (_e) {
    return false;
  }
}

// ==========================================
// シートデータ読み書き
// ==========================================

function readServerBottles(bottlesSheet) {
  var values = bottlesSheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var jsonStr = row[7];
    if (jsonStr) {
      try {
        var record = JSON.parse(jsonStr);
        list.push(record);
      } catch (_e) {
        // パースエラー行はスキップ
      }
    }
  }
  return list;
}

function writeServerBottles(bottlesSheet, bottles) {
  var rows = bottles.map(function (b) {
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
  });

  bottlesSheet.clearContents();
  bottlesSheet.appendRow([
    'id', 'updatedAt', 'createdAt', 'deleted', 'name', 'category', 'status', 'recordJson',
  ]);
  bottlesSheet.setFrozenRows(1);
  if (rows.length > 0) {
    bottlesSheet.getRange(2, 1, rows.length, 8).setValues(rows);
  }
}

function readServerPhotoMetas(photosSheet) {
  var values = photosSheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var jsonStr = row[7];
    if (jsonStr) {
      try {
        var meta = JSON.parse(jsonStr);
        list.push(meta);
      } catch (_e) {
        // パースエラー行はスキップ
      }
    }
  }
  return list;
}

function writeServerPhotoMetas(photosSheet, photoMetas) {
  var rows = photoMetas.map(function (p) {
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
  });

  photosSheet.clearContents();
  photosSheet.appendRow([
    'id', 'bottleId', 'contentHash', 'driveFileId', 'updatedAt', 'createdAt', 'deleted', 'metaJson',
  ]);
  photosSheet.setFrozenRows(1);
  if (rows.length > 0) {
    photosSheet.getRange(2, 1, rows.length, 8).setValues(rows);
  }
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
    syncMetaSheet.getRange(foundRow, 2).setValue(isoString);
    syncMetaSheet.getRange(foundRow, 3).setValue(isoString);
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
  var bottles = readServerBottles(ssContext.bottlesSheet);
  var photos = readServerPhotoMetas(ssContext.photosSheet);

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
function handleSyncMetadata(request, ssContext, _driveContext) {
  var clientBottles = Array.isArray(request.bottles) ? request.bottles : [];
  var clientPhotoMetas = Array.isArray(request.photoMetas) ? request.photoMetas : [];
  var isInitialEmptyClient = Boolean(request.isInitialEmptyClient);
  var nowIso = new Date().toISOString();

  var serverBottles = readServerBottles(ssContext.bottlesSheet);
  var serverPhotoMetas = readServerPhotoMetas(ssContext.photosSheet);

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

  // B. 写真メタデータの LWW マージ
  var rawMergedPhotoMetas = [];
  if (isInitialEmptyClient) {
    rawMergedPhotoMetas = serverPhotoMetas.slice();
  } else {
    var serverPhotoMap = {};
    serverPhotoMetas.forEach(function (p) { serverPhotoMap[p.id] = p; });
    var clientPhotoMap = {};
    clientPhotoMetas.forEach(function (p) { clientPhotoMap[p.id] = p; });

    var allPhotoIds = {};
    serverPhotoMetas.forEach(function (p) { allPhotoIds[p.id] = true; });
    clientPhotoMetas.forEach(function (p) { allPhotoIds[p.id] = true; });

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
        rawMergedPhotoMetas.push(sPhoto);
      } else if (cPhoto) {
        rawMergedPhotoMetas.push(cPhoto);
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

  // D. Drive 上の trashed 状態確認と重複排除マップの構築 (PR #11 申し送り事項)
  // 有効な写真 (deleted === false) に限定して、既存の driveFileId が Drive 上で trashed でないか確認する
  var activeDriveIdCache = {}; // driveFileId -> boolean
  var knownHashToDriveId = {}; // contentHash -> driveFileId

  for (var j = 0; j < reconciledPhotoMetas.length; j++) {
    var pMeta = reconciledPhotoMetas[j];
    if (pMeta.driveFileId) {
      if (activeDriveIdCache[pMeta.driveFileId] === undefined) {
        activeDriveIdCache[pMeta.driveFileId] = isDriveFileActive(pMeta.driveFileId);
      }
      var isActive = activeDriveIdCache[pMeta.driveFileId];
      if (!isActive) {
        // Drive 上で削除済み・存在しないファイル ID は死んだ ID としてクリア
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

  // E. 孤立した Drive ファイルのゴミ箱移動 (setTrashed(true))
  // 有効な写真のいずれからも参照されなくなった driveFileId を特定してゴミ箱へ移動
  var activeDriveIdsInUse = {};
  reconciledPhotoMetas.forEach(function (p) {
    if (!p.deleted && p.driveFileId) {
      activeDriveIdsInUse[p.driveFileId] = true;
    }
  });

  reconciledPhotoMetas.forEach(function (p) {
    if (p.deleted && p.driveFileId && !activeDriveIdsInUse[p.driveFileId]) {
      try {
        var fileToTrash = DriveApp.getFileById(p.driveFileId);
        if (!fileToTrash.isTrashed()) {
          fileToTrash.setTrashed(true);
        }
      } catch (_e) {
        // 既にゴミ箱にあるかアクセスできない場合はスキップ
      }
    }
  });

  // F. アップロードが必要な写真 ID リスト (photosToUpload) の算出
  // クライアント側で有効かつ driveFileId が未確定の写真 ID
  var photosToUpload = [];
  reconciledPhotoMetas.forEach(function (p) {
    if (!p.deleted && !p.driveFileId) {
      photosToUpload.push(p.id);
    }
  });

  reconciledPhotoMetas.sort(function (a, b) { return a.id.localeCompare(b.id); });

  // G. シート一括書き込み
  writeServerBottles(ssContext.bottlesSheet, mergedBottles);
  writeServerPhotoMetas(ssContext.photosSheet, reconciledPhotoMetas);
  updateLastSyncedAt(ssContext.syncMetaSheet, nowIso);

  return makeJsonResponse({
    ok: true,
    bottles: mergedBottles,
    photoMetas: reconciledPhotoMetas,
    photosToUpload: photosToUpload,
    syncedAt: nowIso,
  });
}

/**
 * 3. upload_photo アクション
 */
function handleUploadPhoto(request, ssContext, driveContext) {
  var photo = request.photo;
  if (!photo || !photo.id || !photo.bottleId || !photo.contentHash || !photo.dataUrl) {
    return makeJsonResponse({
      ok: false,
      errorCode: 'INVALID_PHOTO_PAYLOAD',
      message: '写真ペイロードが不正です (id, bottleId, contentHash, dataUrl が必要です)',
    });
  }

  var photos = readServerPhotoMetas(ssContext.photosSheet);
  var nowIso = new Date().toISOString();

  // A. contentHash 重複排除: 既存の有効かつ trashed でないファイルを検索
  var deduplicatedDriveId = null;
  for (var i = 0; i < photos.length; i++) {
    var p = photos[i];
    if (p.contentHash === photo.contentHash && p.driveFileId && !p.deleted) {
      if (isDriveFileActive(p.driveFileId)) {
        deduplicatedDriveId = p.driveFileId;
        break;
      }
    }
  }

  var finalDriveFileId = deduplicatedDriveId;
  var isDeduplicated = Boolean(deduplicatedDriveId);

  // B. 重複排除できなければ Drive に新規作成
  if (!finalDriveFileId) {
    var matches = photo.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches || !matches[1] || !matches[2]) {
      return makeJsonResponse({
        ok: false,
        errorCode: 'INVALID_DATA_URL',
        message: 'dataUrl の形式が不正です (data:image/...;base64,... 形式が必要です)',
      });
    }

    var mimeType = matches[1];
    var base64Data = matches[2];
    var ext = mimeType.indexOf('webp') !== -1 ? 'webp' : 'jpg';
    var fileName = 'sake-photo-' + photo.contentHash.slice(0, 12) + '-' + photo.id + '.' + ext;

    var decodedBytes = Utilities.base64Decode(base64Data);
    var blob = Utilities.newBlob(decodedBytes, mimeType, fileName);
    var createdFile = driveContext.folder.createFile(blob);
    finalDriveFileId = createdFile.getId();
  }

  // C. Photos シートのレコードを更新または追加
  var found = false;
  for (var j = 0; j < photos.length; j++) {
    if (photos[j].id === photo.id) {
      photos[j].driveFileId = finalDriveFileId;
      photos[j].updatedAt = nowIso;
      found = true;
      break;
    }
  }

  if (!found) {
    var newMeta = {
      id: photo.id,
      bottleId: photo.bottleId,
      mimeType: photo.mimeType || 'image/jpeg',
      width: photo.width || 0,
      height: photo.height || 0,
      byteSize: photo.byteSize || 0,
      contentHash: photo.contentHash,
      driveFileId: finalDriveFileId,
      createdAt: photo.createdAt || nowIso,
      updatedAt: nowIso,
      deleted: photo.deleted === true,
    };
    photos.push(newMeta);
  }

  writeServerPhotoMetas(ssContext.photosSheet, photos);
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
  var photoIds = Array.isArray(request.photoIds) ? request.photoIds : [];
  if (photoIds.length === 0) {
    return makeJsonResponse({
      ok: true,
      photos: [],
    });
  }

  var metas = readServerPhotoMetas(ssContext.photosSheet);
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
      } catch (_e) {
        // ファイル取得失敗時はスキップ
      }
    }
  }

  return makeJsonResponse({
    ok: true,
    photos: downloadedPhotos,
  });
}
