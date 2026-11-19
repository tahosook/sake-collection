# sake-collection 障害・設計判断ログ

作成日: 2026-11-19
正本開発ルール: `AGENTS.md` §9
運用手順書: `docs/step4-operations.md`

本書は、`sake-collection` の本番・プレビュー環境で発生した障害・インシデントの記録、および設計・運用上の重要な判断の経緯を残す正本ドキュメントです。

---

## 1. 記録ルール

1. **記録対象**:
   - **障害・インシデント（`INC-xxx`）**: 本番またはプレビュー環境で発生した障害、デプロイ事故、データ不整合、セキュリティ事象（発生日・事象・原因・影響・応急対応・恒久対策・教訓・関連 PR/コミット）。
   - **設計・運用判断（`DEC-xxx`）**: 仕様・データ整合・セキュリティ・運用方針に関わる重要な意思決定（判断日・背景・採用方針・代替案と不採用理由・制約/トレードオフ・関連 PR/コミット）。
2. **プライバシー・秘匿情報の非記載（厳守）**:
   - 本リポジトリは公開（Public）です。実データ（個人の酒データ・写真）、個人のメールアドレス、合言葉（`SYNC_PASSPHRASE` 等）、Google リソースの実 ID（Spreadsheet ID / Drive Folder ID / GAS Script ID / Deployment ID）、実 GAS デプロイ URL は**一切記載しません**。すべて `<...>` 形式のプレースホルダで表記し、`npm run verify`（`verify:data`）で検査します。

---

## 2. 障害・インシデント記録

### INC-001（2026-11-12）: `clasp push` 時の `gas/appsscript.json` `webapp` 設定欠落による本番 GAS 404 事故

- **発生日**: 2026-11-12
- **事象**: PR #21（`a1522ea`, `chore/introduce-clasp`）で `clasp` による GAS デプロイ自動化を導入した直後、`clasp push` を実行した本番 GAS Web アプリのエンドポイントが JSON 応答ではなく 404 HTML ページを返す状態になった。
- **原因**: `gas/appsscript.json` に Web アプリ設定（`webapp.executeAs` および `webapp.access`）が定義されていなかったため、`clasp push` 時にマニフェスト上書きによって Web アプリ公開設定が欠落した。また、`clasp deploy` による版更新でもデプロイ側の実行権限設定がマニフェストのみでは保証されない点を事前手順に織り込めていなかった。
- **影響**: 該当デプロイ更新の間、Web アプリ URL への同期・疎通リクエストが 404 で失敗する状態となった（スプレッドシート・Drive 上の既存データ破損はなし）。
- **応急対応・復旧**: GAS エディタ（GUI）の「デプロイを管理」からWeb アプリ設定（次のユーザーとして実行:「自分」、アクセスできるユーザー:「全員」）を復旧して再確認した。
- **恒久対策（PR #22: `09504ca`, コミット `1be2ce6` / `1874145`）**:
  1. `gas/appsscript.json` に `"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }` を明示追加した。
  2. `docs/step4-operations.md` §6.4 に、`clasp` 運用でもマニフェスト確認および反映後の fail-closed 疎通確認（GET で `METHOD_NOT_ALLOWED`、不正合言葉 POST で `UNAUTHORIZED` の JSON が返ること）を必須とし、期待どおりの JSON が返らず 404 等になった場合の GUI 復旧手順を明文化した。
- **教訓**: `clasp push` / `clasp deploy` 前後の `gas/appsscript.json` 差分確認と、デプロイ直後の `curl -L` による fail-closed 疎通確認を省略しない。

---

## 3. 主要な設計・運用判断ログ

### DEC-001（2026-11-19）: バックアップ復元の巻き戻り防止（M1）と合言葉漏洩時全消去ガード（M5）の両立

- **背景**: 全体点検で「バックアップ復元後に同期するとクラウド側の新しい更新日時・削除記録に負けて巻き戻る（M1）」と「合言葉漏洩時に全件削除同期でクラウドデータを消去できる（M5）」が同時に見つかった。
- **採用方針**:
  - サーバー（GAS）側にはクライアント指示で無条件全置換できるバイパスフラグを**設けない**。
  - M1 対策はクライアント側で完結させ、`importBackupData`（`src/storage/db.ts`）で復元レコードの `updatedAt` を既存 DB・バックアップ内最大値より新しい `restoredAt` へ昇格、復元写真の `driveFileId` を `null` 化、復元前にその端末へ存在したバックアップ外ボトルをトームストーン化（同期済み写真は `pendingDeletedPhotos` へ退避）し、さらに復元直後の同期開始時に `ping.serverTime` との比較によるクロックスキュー補正（`bumpLocalRecordsUpdatedAt`）を行う。
  - M5 対策は GAS 側（`gas/Code.gs`）にスキーマ検証・サーバー時刻 `+24h` 超の未来日時拒否（`INVALID_TIMESTAMP`）・大量削除ガード（`MASS_DELETE_BLOCKED`: 既存 5 本以上の過半数かつ 5 本以上削除、既存 3 本以上からの全件 0 本化、Drive 20 件超のゴミ箱移動を拒否）を配置した。なお正規操作「全データを削除して初期化」（`clearDatabase()`）はローカル初期化のみであり次回同期が `isInitialEmptyClient: true` となるため、`MASS_DELETE_BLOCKED` に抵触しない。
- **不採用とした代替案**: リクエストに `forceReplaceAll: true` 等のサーバー側全置換フラグを足す案（合言葉が漏洩した攻撃者も同フラグを送信でき M5 が無力化されるため不採用）。
- **制約・トレードオフ**: 復元前に端末内に無かったクラウド側の別ボトルは和集合マージで合流し、非常に大規模な削除を含む復元は安全装置によりブロックされる（詳細を `docs/step4-operations.md` §6.2 に明記）。
- **関連 PR**: PR #30（`b25b0df`）, PR #32（`df888fc`）

### DEC-002（2026-11-19）: GAS シートの非破壊上書き（`clearContents()` 廃止）と破損行 fail-closed 化（M2）

- **背景**: 従来の `gas/Code.gs` は `clearContents()` でシート全消去後に書き込んでいたため途中失敗でデータと削除記録が消失し、さらに JSON パース不能行を黙殺して次回全書きで恒久欠落させていた。
- **採用方針**:
  - Google Sheets API には SQL トランザクションが存在しないため、`clearContents()` を完全撤去し、事前のセル文字数検証（安全上限 49,000 文字）を通した上でヘッダー＋全行を単一の `setValues` で先頭から一括上書きし、行数が減った場合のみ書き込み成功後に余剰末尾行を `clearContent()` する方式（`writeSheetRowsSafely`）とした。
  - `upload_photo` はシート全体再書きではなく単一行更新／追記（`upsertServerPhotoMeta`）とし、読み込み時は非空行の JSON 破損を `CORRUPTED_SHEET_DATA` で即停止（fail-closed）とした。
- **関連 PR**: PR #30（`b25b0df`）

### DEC-003（2026-11-19）: Drive 3値状態判定（M3）と本番 `gas/Code.gs` 直接実行テスト基盤（D3）

- **背景**: 従来は `DriveApp.getFileById` の全例外を「ファイル不存在」とみなして `driveFileId` を消去しており、またテストの厚い `mergeBottleCollections` と別立てで `gas/Code.gs` 本番実装には恒常テストがなかった。
- **採用方針**:
  - Drive 確認を `'active' | 'missing' | 'error'` の3値に厳格化し、ゴミ箱入りまたは明確な不存在エラー時のみ `'missing'` として扱い、一時エラー時は `DRIVE_TEMPORARY_ERROR` で停止して `driveFileId` を保護する。あわせてクライアント由来キーの辞書はプロトタイプ衝突を防ぐため `Object.create(null)` で構築する。
  - テスト用の別実装・複製は作らず、`node:vm` ハーネス（`tests/helpers/gasTestHarness.ts`）から本番デプロイ対象の `gas/Code.gs` そのものを読み込んで単体テスト（`tests/gasBackend.test.ts`）およびクライアント×GAS 結合テスト（`tests/syncService.test.ts`）を恒常実行する体制とした。
- **関連 PR**: PR #30（`b25b0df`, 修正コミット `86951e9`）, PR #31（`fafc5a2`）

### DEC-004（2026-11-19）: 同期中のローカル編集の絶対保護（S2）

- **背景**: 同期の通信待ち（Phase 1〜3）の間に端末側で行われた編集が、Phase 4 の一括反映で上書き消失する恐れがあった。また、同期中編集の比較を通常の LWW（`mergeBottleRecords`）に委ねると、`updatedAt` 同値（サーバー優先）や他端末の時計進み時にローカル変更が消える問題がレビューで確認された。
- **採用方針**: `executeFullSync` にモジュールレベル排他（`isSyncInFlight`）と開始時スナップショットを導入し、Phase 4（`commitSyncResultToDb`）で同期中のローカル変更を検出したボトルについては通常 LWW に委ねず無条件でローカル版を保持して `hasPendingLocalChanges: true` を返し、`pendingDeletedPhotos` も送信済み分のみ差分クリアしてユーザーに再同期を案内する方式とした。
- **関連 PR**: PR #31（`fafc5a2`, 修正コミット `b4ce153`）

### DEC-005（2026-11-19）: ルート直下 `local-data/` の走査除外と Git 追跡防止検査の両立（D1）

- **背景**: `AGENTS.md` §6 は実データ置き場として `.gitignore` 対象の `local-data/` を指定しているが、`scripts/verify-data.ts` が `local-data/` まで走査していたため規則どおり配置すると `npm run verify` が失敗していた。
- **採用方針**: リポジトリルート直下の `local-data/` のみファイルシステム走査から除外しつつ、`git ls-files -- local-data` の結果が 0 件であることを `verify:data` で強制検査し、`dist/` など他階層への混入監視も維持する方式とした。
- **関連 PR**: PR #33（`ab8d3c2`）
