# sake-collection 全体点検修正 設計書（M1〜M5 / S1〜S6 / AI-2 / D1〜D6 / N1 / N3）

作成: Antigravity の Argon（2026-11-19）。
正本要件: `docs/requirements.md`、全体設計: `docs/architecture.md`、同期設計: `docs/step3-4-design.md`、開発ルール: `AGENTS.md`。

---

## 1. 対象範囲と基本方針

Opus 5.5 の全体点検で見つかり、コードで裏取り済みの指摘（Must 5件・Should 7件・文書 5件＝計17項目）に対する修正設計を定める。

### 変えてはいけないこと（全体不変条件）
1. **データ形式の後方互換**: 既存のサーバーデータ（`Bottles` / `Photos` / `SyncMeta` シートの列構成・JSON 構造）および既存のローカルバックアップ JSON（`schemaVersion: 1`）が引き続き読み込めること。
2. **認証・接続方式の維持**: GAS のデプロイ URL（`clasp deploy -i <DEPLOYMENT_ID>` で維持）と合言葉（`SYNC_PASSPHRASE`）＋ Cloudflare Access の2層境界を変えないこと。
3. **アプリ目的と検証規律の維持**: 一覧・詳細の見やすさ、登録の手軽さ、在庫の正確さを損なわないこと。全 PR で `npm run verify`（`verify:data` / `verify:types` / `verify:lint` / `verify:test` / `verify:build`）が exit 0 で通ること。

### 設計上の要（項目間の相互作用）
- **M1（バックアップ復元の巻き戻り防止）と M5（合言葉漏洩時の全消去防止）の両立**:
  - サーバー側に無条件全置換フラグは設けない（合言葉漏洩時に M5 を突破されるため）。
  - 復元時にローカル側で復元レコードの `updatedAt` を最新時刻（＋同期時 `ping.serverTime` によるクロックスキュー補正）へ昇格させ、復元前に端末内に存在したバックアップ外ボトルをトームストーン化する。一方 GAS 側には1回の同期での大量削除・全消去を防ぐ安全装置（`MASS_DELETE_BLOCKED`）を設けつつ、本人の正規操作「全データを削除して初期化」（ローカル IndexedDB クリア → `isInitialEmptyClient: true` 同期）は阻害しない。
- **M4（書き出し自己検証）と S6（低メモリ書き出し）の両立**:
  - `exportBackupBlob()` で IndexedDB カーソルを1件ずつ走査しながら、`validatePhotoRecord` → コンパクト JSON 化 → 小チャンク `Blob` 化で文字列参照を即解放し、最後に軽量な ID マップでボトル検証・双方向参照整合を完了させる。
- **D3（GAS 本番ロジックの恒常テスト）**:
  - テスト用の別実装を作らず、`node:vm` ハーネスから本番デプロイ対象の `gas/Code.gs` そのものを読み込み、障害注入可能なインメモリモック上で単体テストおよびクライアント×GAS 結合テストを恒常実行する。

---

## 2. 項目ごとの詳細設計と受け入れ条件

### Must（5件）

#### M1: バックアップ復元が次の同期で巻き戻る
- **修正内容**:
  1. `importBackupData`（`src/storage/db.ts`）の単一トランザクション内で、復元時刻 `restoredAt`（`nowIso`・復元前ローカル最大 `updatedAt`・バックアップ内最大 `updatedAt` の最大値より真に新しい ISO 8601 UTC）を算出し、復元ボトルおよび復元写真の `updatedAt` を `restoredAt` に引き上げる。
  2. 復元写真の `driveFileId` を `null` にリセットする（クラウド上の有効な同一 `contentHash` ファイルは Phase 1/2 の重複排除で再利用され、欠損・ゴミ箱行き時は確実に再アップロードされる）。
  3. 復元前にその端末に存在しバックアップに含まれない有効ボトルを `deleted: true, updatedAt: restoredAt, photoIds: [], primaryPhotoId: null` のトームストーンとして残し、紐づく同期済み写真は `pendingDeletedPhotos` へ退避する。
  4. `syncDownloadCache` を削除、`isSampleDataLoaded` を `hasSampleDataRecords(bottles)` に合わせて更新、`pendingBackupRestoreAt: restoredAt` を `meta` ストアへ記録する。
  5. `executeFullSync`（`src/services/syncService.ts`）は `pendingBackupRestoreAt` がある場合、Phase 1 前に `ping` で `serverTime` を取得し、`serverTime >= pendingBackupRestoreAt` ならローカル全レコードの `updatedAt` を `serverTime + 1000ms` へ引き上げてから同期し、Phase 4 完了時に `pendingBackupRestoreAt` を削除する。
- **受け入れ条件**:
  - 既存の `schemaVersion: 1` バックアップ JSON がそのまま復元できること。
  - バックアップ作成後にクラウド側で編集・削除が行われた状態からバックアップを復元し、続けて同期しても復元内容が巻き戻らずクラウド側へ反映されること。
  - 復元前に端末に存在したバックアップ外ボトルが次回同期で復活しないこと。
  - 端末時計がサーバーより遅れている場合でも、`ping` の `serverTime` 補正により巻き戻らないこと。

#### M2: GAS シート書き込みの非原子性と破損 JSON 行の黙殺
- **修正内容**:
  1. `readServerBottles` / `readServerPhotoMetas`（`gas/Code.gs`）で、2行目以降の非空行に JSON 空欄・構文エラー・非オブジェクト・`id` 欠落があった場合、黙って飛ばさず `CORRUPTED_SHEET_DATA` エラーで fail-closed 停止し、シートを一切書き換えない。
  2. `clearContents()` による全消去を完全撤去し、共通関数 `writeSheetRowsSafely(sheet, headers, rows, sheetLabel)` を導入する。
     - 書き込み前にメモリ上で全行を構築し、全セルが 49,000 文字以下であることを事前検証（超過時は `RECORD_TOO_LARGE` で拒否）。
     - ヘッダー＋全データ行を単一の `sheet.getRange(1, 1, allRows.length, headers.length).setValues(allRows)` で先頭から上書きする。
     - 既存行数が減った場合のみ、書き込み成功**後**に余剰末尾行を `clearContent()` する。
  3. `handleUploadPhoto` は `Photos` シート全体の再書き込みをやめ、既存行が見つかればその1行のみ `setValues` で更新、新規なら `appendRow` する。
- **受け入れ条件**:
  - `gas/Code.gs` にシート全体の `clearContents()` 呼び出しが存在しないこと。
  - 書き込み中に例外が発生する障害注入テストで、既存シートのデータおよび削除記録が空にならず残ること。
  - パース不能な JSON 行を含むシートに対して `sync_metadata` / `upload_photo` / `ping` を実行した際、`CORRUPTED_SHEET_DATA` で停止しシートが書き換わらないこと。
  - 49,000 文字超のレコードが書き込み前に `RECORD_TOO_LARGE` で拒否されること。

#### M3: Drive 一時エラー時の `driveFileId` 誤消去
- **修正内容**:
  1. `checkDriveFileStatus(fileId, activeFolderFileSet)` を導入し、`'active' | 'missing' | 'error'` の3値を厳密に区別する。
     - `'active'`: ファイルが存在し `!file.isTrashed()`。
     - `'missing'`: `file.isTrashed() === true`、または例外が明確な不存在エラーである場合のみ。
     - `'error'`: クォータ超過・タイムアウト・サービス一時障害・その他不明エラー。
  2. `handleSyncMetadata` では `driveContext.folder.getFiles()` でフォルダ内の有効ファイル ID 集合を事前取得して API 呼び出し数を抑える。
  3. `folder.getFiles()` または `checkDriveFileStatus` が `'error'` となった場合、`driveFileId` を一切クリアせず、シート書き込みも Drive ゴミ箱移動も行わず `DRIVE_TEMPORARY_ERROR` を返して安全停止する。`driveFileId = null` へのクリアは `'missing'` 確定時のみ行う。
  4. `handleUploadPhoto` の重複排除チェック、`handleDownloadPhotos` の取得でも一時エラー時は `DRIVE_TEMPORARY_ERROR` を返し安全側に倒す。
- **受け入れ条件**:
  - Drive API が一時障害・クォータ超過・タイムアウト例外を返した際、`DRIVE_TEMPORARY_ERROR` が返り、`Photos` シートの既存 `driveFileId` が1件も消されないこと。
  - Drive 上でゴミ箱移動済みまたは明確な不存在の場合のみ、`driveFileId` が `null` にクリアされること。

#### M4: 写真送信途中停止による別端末バックアップ破損と、書き出し自己検証の欠如
- **修正内容**:
  1. `reconcilePhotosWithBottles`（`src/domain/syncMerge.ts`）が「有効（`!deleted`）かつローカル画像なし、かつ `driveFileId === null` の写真」を `missingRemotePhotoIds` として返す。
  2. `commitSyncResultToDb`（`src/storage/db.ts`）は、ローカル `photos` ストアに実体が存在しない写真 ID を保存先ボトルの `photoIds` / `primaryPhotoId` から除外して保存する（`bottle.updatedAt` は変更しない）。これにより他端末のローカル整合が保たれ、元端末が再同期して写真アップロード完了後に他端末が再同期すると同一 `updatedAt` タイブレーク（サーバー優先）で写真が自動復旧する。
  3. `executeFullSync` Phase 2 で、サーバー側 `photoMetas` 上の `driveFileId` が `null` の写真はローカルに古い ID が残っていても再アップロード対象とする。
  4. `exportBackupData` / `exportBackupBlob` は欠損写真参照の正規化を行った上で、出力確定前に全件スキーマ・双方向整合の自己検証を必ず実行する。検証失敗時はファイルを出力せず、`lastBackupAt` も更新しない。
- **受け入れ条件**:
  - 「端末Aが写真付きボトルを同期開始 → Phase 2 中断 → 端末Bが同期 → 端末Bがバックアップ書き出し → 検証＆復元」が一貫して成功すること。
  - その後「端末Aが再同期してアップロード完了 → 端末Bが再同期」で端末Bにも写真が復元されること。
  - DB に不正レコードがある場合、書き出し自己検証でエラーになり壊れたバックアップファイルが生成されないこと。

#### M5: 合言葉漏洩時の全データ消去リスクと漏洩時対応手順書の欠如
- **修正内容**:
  1. GAS 側で全リクエストペイロードを検証する：
     - `sync_metadata`: 件数上限（ボトル 2,000件、写真メタ 10,000件）、UUID・固定10種・固定4種・ISO 8601 UTC・64桁 hex ハッシュ等のスキーマ検証（`INVALID_PAYLOAD`）。
     - 未来日時ガード：クライアント送信 `createdAt` / `updatedAt` がサーバー時刻 `+24時間` を超える場合は `INVALID_TIMESTAMP` で拒否。
     - `upload_photo`: UUID・`contentHash`・`dataUrl` MIME（`image/jpeg` / `image/webp` 限定）・デコード後サイズ上限（5MB）検証。
     - `download_photos`: `photoIds` 件数上限（10件）・UUID 検証。
  2. 大量削除・全消去防止ガード（`MASS_DELETE_BLOCKED`）：
     - マージ前のサーバー有効ボトル数と比較し、以下のいずれかに該当する場合はシート書き込みも Drive ゴミ箱移動も一切行わず `MASS_DELETE_BLOCKED` で拒否する：
       - 既存有効ボトルが5本以上あり、1回の同期で新たに論理削除される本数が過半数（50%超）かつ5本以上。
       - 既存有効ボトルが3本以上あり、1回の同期で全件（100%）が0本に消去される。
       - 1回の同期で Drive ゴミ箱移動対象となるファイル数が20件超。
     - なお、本人の正規操作「全データを削除して初期化」（`clearDatabase()`）はローカル IndexedDB のみを初期化し、次回同期は `isInitialEmptyClient: true` となるため、`MASS_DELETE_BLOCKED` には抵触しない。
  3. `docs/step4-operations.md` に「合言葉漏洩時の緊急対応・データ復旧手順」を追記する。
- **受け入れ条件**:
  - 既存有効ボトル10本に対して全件 `deleted: true` や6本以上同時削除を送った際、`MASS_DELETE_BLOCKED` で拒否され、シートと Drive が一切変更されないこと。
  - 未来日時（例 `2099-01-01T00:00:00.000Z`）や不正スキーマ・不正 MIME Type が拒否されること。
  - 通常の削除（1〜4本、または全体の50%以下）および「全データを削除して初期化」からの再同期が正常に動作すること。
  - 運用手順書に漏洩時の初動・確認・復旧・再展開手順が実 ID・実合言葉を含まない形で明記されていること。

---

### Should（7件）

- **S1（GAS エラー `message` 読み取り・合言葉変更時自動再取得）**:
  - `src/types/sake.ts` の同期レスポンス型へ `message?: string` を追加し、`src/services/syncService.ts` で `res.message || res.error || fallback` に統一する。
  - `executeFullSync` で `config.source === 'auto'` かつ `errorCode === 'UNAUTHORIZED'` の場合のみ `/api/sync-config` を1回自動再取得し、更新されていれば1回リトライする。`SyncSection.tsx` は同期後に設定表示を更新する。
- **S2（同期中編集の上書き防止）**:
  - `executeFullSync` にインフライト排他制御を追加し、開始時のボトル `updatedAt` スナップショットと `pendingDeletedPhotos` スナップショットを `commitSyncResultToDb` へ渡す。
  - `commitSyncResultToDb` 内で同期中に更新・追加されたローカルレコードを `mergeBottleRecords` で保護し、`pendingDeletedPhotos` も送信済み分のみを除去する。保護発生時は `SyncResult.hasPendingLocalChanges = true` で再同期を案内する。
- **S5（バックアップ読み込み確認画面）**:
  - `DataManagementView.tsx` でファイル選択直後に `validateBackupData` のみ実行し、成功時は件数・出力日時・既存件数・上書き警告を表示する確認モーダルを経由して確定時のみ `onImportBackup` を実行する。
- **S6（バックアップ書き出しのメモリ効率化）**:
  - `src/storage/db.ts` に `exportBackupBlob()` を新設し、`photos` ストアを `openCursor()` で1件ずつ検証・コンパクト JSON 化・小チャンク `Blob` 化してピークメモリを削減する。`DataManagementView.tsx` は `exportBackupBlob()` を利用する。
- **AI-2（Gemini プロンプト見本 JSON のコメント除去）**:
  - `src/domain/geminiPrompt.ts` の `buildGeminiConsultationPrompt()` 内コードブロックから `/* ... */` を完全に除去し、純粋な有効 JSON 見本にする。種類別属性の説明はコードブロック直前へ移動する。
- **D1（`local-data/` と `verify-data` の衝突解消）**:
  - `scripts/verify-data.ts` でリポジトリルート直下の `local-data/` のみファイルシステム走査から除外し、あわせて `git ls-files -- local-data` が0件であることを検査する。
- **D3（GAS 本番ロジックの恒常テスト）**:
  - `tests/helpers/gasTestHarness.ts` を新設し、`node:vm` で本番 `gas/Code.gs` を直接実行可能にする。`tests/gasBackend.test.ts`（GAS 単体・障害注入テスト）および `tests/syncService.test.ts`（クライアント×GAS 結合テスト）を追加する。`gas/Code.gs` にも `request.pendingDeletedPhotos` のマージを実装する。

### 文書の追記・訂正（5件）

- **D4**: `AGENTS.md` §9 の「後から足すルール（今は決めない）」を確定済み参照先へ更新。
- **D5**: `docs/decisions-and-incidents.md` を新設し、過去の GAS `webapp` 設定欠落による 404 事故（`1be2ce6`）と今回点検の判断を記録。記録場所ルールを `AGENTS.md` に明記。
- **D6**: `docs/step4-operations.md` のバックアップ復元制約・合言葉自動再取得・UI 表記を実装と一致させ、M5 漏洩時手順を追記。
- **N1**: 各設計書（`gemini-batch-import-design.md`, `step3-4-design.md`, `architecture.md`, `step1-design.md`, `step2-design.md`）の古い記述・パス誤りを訂正。
- **N3**: `README.md` のドキュメント一覧へ `docs/pwa-design.md`・`docs/decisions-and-incidents.md`・`docs/audit-fixes-design.md` を追加。

---

## 3. PR 分割案（全 5 PR）

| PR | ブランチ名 | 対象項目 | 主な対象ファイル |
| :-: | :--- | :--- | :--- |
| PR 1 | `fix/gas-hardening-and-tests` | M2, M3, M5(GAS), D3(GASテスト基盤) | `docs/audit-fixes-design.md`, `gas/Code.gs`, `tests/helpers/gasTestHarness.ts`, `tests/gasBackend.test.ts` |
| PR 2 | `fix/sync-client-resilience-and-error-handling` | S1, S2, M4(同期側), D3(結合テスト) | `src/types/sake.ts`, `src/domain/syncMerge.ts`, `src/storage/db.ts`, `src/services/syncService.ts`, `src/components/SyncSection.tsx`, `tests/syncMerge.test.ts`, `tests/syncService.test.ts` |
| PR 3 | `fix/backup-restore-and-streaming-export` | M1, M4(書き出し側), S5, S6 | `src/storage/db.ts`, `src/services/syncService.ts`, `src/storage/useCollection.ts`, `src/components/DataManagementView.tsx`, `src/App.tsx`, `tests/storage.test.ts`, `tests/syncService.test.ts` |
| PR 4 | `fix/prompt-json-and-verify-local-data` | AI-2, D1 | `src/domain/geminiPrompt.ts`, `tests/geminiImport.test.ts`, `scripts/verify-data.ts` |
| PR 5 | `docs/rules-operations-and-incident-log` | M5(手順書), D4, D5, D6, N1, N3 | `docs/decisions-and-incidents.md`, `AGENTS.md`, `docs/step4-operations.md`, `docs/step1-design.md`, `docs/step2-design.md`, `docs/step3-4-design.md`, `docs/architecture.md`, `docs/gemini-batch-import-design.md`, `README.md` |
