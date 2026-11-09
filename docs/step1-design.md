# sake-collection ステップ1 詳細設計・受入条件

作成: Antigravity の Argon（2026-11-08）。全体設計は docs/architecture.md、要件は docs/requirements.md、開発ルールは AGENTS.md。
ステップ1の範囲：コレクションの把握（最小版）。一覧・詳細・最小の手入力登録・状態変更・バックアップ・サンプルデータ。

## 1. 詳細設計

### (1) 一覧画面（いま家にある酒）とまとめ表示
- 表示形式：2列〜複数列の写真グリッド。写真がないボトルは種類に応じたプレースホルダー＋銘柄名・種類バッジを表示
- まとめ表示：全体設計 §3 のグループ化で計算する。2本以上のグループには本数バッジと代表状態バッジを表示
- タップ時：1本なら直接詳細画面へ。2本以上ならグループ内個体リスト（モーダルシート）を開き、状態・購入日などを見て1本ずつ詳細画面を開ける
- 絞り込みと検索：種類フィルタ、状態フィルタ（すべて／開封済みのみ／未開封のみ）、検索バー（名前＋主要属性を部分一致で検索）。検索時は「いま家にある酒」と「飲んだ記録」の両方の結果を確認できる
- すべてのタップ対象は 44px 以上

### (2) 詳細画面と開封日数
- 表示内容：写真ビューア（複数枚は横スワイプ／サムネイル切り替え、代表1枚の識別表示）、名前、種類、状態バッジ、度数、容量、種類別属性、状態・日付欄（状態変更 UI）、解説（4部構成）と出典 URL、購入情報、相場目安（購入価格とは別欄）
- 開封日数の補助表示：status が opened かつ openedDate がある場合のみ、開封日欄に「2026-10-25（開封から14日）」のように補助表示する。一覧画面には表示しない

### (3) 最小の手入力登録と状態変更（開封日・各日付の扱いを含む）
- 入力項目：名前（必須・空文字不可）、種類（必須・固定10種から選択）、状態（必須・既定値は未開封。登録時から開封済み・飲み切り・手放したも選択可能）、容量（ml・任意）、度数（%・任意）、種類別主要属性（任意）、購入日・購入場所・購入価格（任意）。写真なしでも登録可能
- 日付の扱い：未開封のときは開封日・飲み切り日・手放した日の入力欄を表示せず、保存時は必ずすべて null とする。開封済みで登録する場合は開封日の入力欄を表示し、任意入力（空欄＝null 可）とする。このとき飲み切り日・手放した日は null。飲み切りで登録する場合は開封日・飲み切り日を任意入力（空欄可）、手放した日は null。手放したで登録する場合は開封日・手放した日を任意入力（空欄可）、飲み切り日は null
- 登録時に id（UUID）、createdAt、updatedAt、deleted=false を付与して IndexedDB に保存する
- 状態変更：詳細画面から状態を変更でき、変更時に updatedAt を更新する。未開封に変更（取り消し）した場合は、開封日・飲み切り日・手放した日をすべて null にクリアする

### (4) バックアップ（書き出し・読み込み）と読み込みエラー時の扱い
- 書き出し：IndexedDB 内の全 bottles（論理削除含む）と全 photos を含む JSON（schemaVersion: 1、exportedAt 付き。ファイル名例：sake-collection-backup-YYYYMMDD.json）をダウンロード出力する
- 読み込みは2段階で厳密に検証する：
  1. JSON 構文解析：失敗した場合は既存データを一切変更せず、日本語のエラーを表示する
  2. スキーマ・整合性検証：schemaVersion が 1 であること、bottles / photos 配列の存在、全レコードの必須項目（UUID 形式の id、非空の name、固定10種の category、固定4種の status、有効な createdAt / updatedAt、真偽値の deleted）、未知の種類・状態が含まれないこと、未開封レコードの日付がすべて null であること、購入価格と相場目安が規定の型で構造分離されていること
- 検証失敗時は部分的な取り込みを一切行わず、既存データを保護したまま、不備のあったレコード・項目を示す日本語エラーを表示して中止する（アトミックな拒否）
- 検証成功時のみ、トランザクション内で bottles / photos ストアへ書き込み、一覧を更新して完了メッセージを表示する

### サンプルデータ
全4状態（未開封・開封済み・飲み切り・手放した）、複数種類、同一銘柄の複数本（例：同じ日本酒720mlが開封済み1本＋未開封1本）、ワインのヴィンテージ違い（例：同一銘柄・同容量で2020年と2021年）を含む。写真は実在のものを使わず、生成したダミー画像またはプレースホルダーとする。

## 2. 受入条件

1. 一覧・並び順：「いま家にある酒」に未開封・開封済みのみが表示され、下部ナビゲーションは「家にある酒／飲んだ記録／登録／データ管理」の4タブであること。飲み切りは「飲んだ記録（時系列）」、手放したは「飲んだ記録」画面内の切り替えから「手放した酒」として分かれて表示されること。並び順が「開封済み ＞ 未開封」→「種類リストの記載順」→「購入日の新しい順（未入力時は登録日で代用）」になっていること
2. まとめ表示：名前＋種類＋容量が一致するボトルが1グループにまとまり、ワインの年違いは別グループになること。グループの位置がグループ内の最優先状態と最新購入日の基準で並ぶこと。絞り込みは1本単位で、表示本数は絞り込み後の本数（飲み切り・手放したを含めない）になること。グループをタップして中のボトルを1本ずつ詳細表示できること
3. 検索・絞り込み：種類と状態で絞り込みできること。名前および主要属性（蔵元・蒸留所・産地・品種など）で検索でき、一覧と飲んだ記録の両方が検索対象になること
4. 詳細・開封日数：詳細画面で写真（複数枚対応）・属性・解説・購入情報が閲覧できること。開封日数は「開封済み」かつ「開封日あり」のときのみ詳細の開封日欄に補助表示され、一覧画面には表示されないこと
5. 最小手入力登録・状態変更・バックアップ：写真なしで最小手入力登録（名前・種類・状態・購入情報）ができ、状態変更ができること。全レコードが id (UUID)・updatedAt・deleted を持ち、購入価格と相場目安が混ざらないデータ構造であること。バックアップの書き出し・読み込みが正常に動作し、壊れた JSON や不正データの読み込み時には既存データを壊さずエラー表示で弾けること。サンプルデータで上記すべてが確認できること
6. 品質・UI 制約：画面文言が日本語、コード識別子が英語、タップ対象が 44px 以上であること。標準検証コマンド（npm run verify）が exit 0 で完了すること

## 3. 標準検証コマンド（npm run verify）

開発ルールの完了条件である「データ検証＋型チェック＋テスト＋ビルド」の4点セットに、検証回避（@ts-ignore や eslint-disable、不正な any 等）を機械的に検出するための lint を加えた計5ステップを直列につなぐ。すべて exit 0 の場合のみ成功とする。

```json
{
  "scripts": {
    "verify": "npm run verify:data && npm run verify:types && npm run verify:lint && npm run verify:test && npm run verify:build",
    "verify:data": "tsx scripts/verify-data.ts",
    "verify:types": "tsc --noEmit",
    "verify:lint": "eslint . --max-warnings 0",
    "verify:test": "vitest run",
    "verify:build": "vite build"
  }
}
```

- verify:data：サンプルデータとテストフィクスチャがスキーマ定義（UUID 形式、ISO 日時、固定10種類、4状態、未開封時の日付 null 制約、購入価格と相場目安の分離）に準拠しているかを検証。ソース全体に @ts-ignore、@ts-expect-error、eslint-disable が含まれていないことを機械的にチェック。実写真ファイルや実データバックアップがトラックされていないかもチェック
- verify:types：tsc --noEmit（strict: true、noUncheckedIndexedAccess: true）
- verify:lint：ESLint（警告0件を強制）
- verify:test：Vitest による恒常ロジック単体テスト（UI 文字列テストは含めない）。ステップ1〜3での対象：グループ化、並び順、購入価格と相場目安の分離、バックアップ JSON のスキーマ検証（ステップ2以降は Gemini 取り込み JSON も）、開封日数の計算と状態変更時の日付整合性。ステップ4で追加する対象：同期マージ（最終更新優先、論理削除の伝播、空端末からの初回同期保護、冪等性）
- verify:build：vite build

## 4. ステップ0（初期コミット）とステップ1の PR 分割案

### ステップ0（初期コミット）
ユーザーの承認を得て、Muse が main へ直接コミットする。
- AGENTS.md（開発ルール）
- docs/requirements.md（要件定義書）、docs/architecture.md（全体設計書）、docs/step1-design.md（本書）
- .gitignore、README.md（最小限の初期ファイル）
完了条件：ドキュメントと開発ルールが main に配置されていること。直後に main のブランチ保護（PR 必須・直接 push 禁止・バイパス不可）を設定する。

### PR #1 feat/step1-scaffold-and-verify
環境構築・全データモデル型定義・サンプルデータ・検証基盤・GitHub Actions。
- Vite + React + TypeScript + Tailwind CSS + Vitest + ESLint の雛形
- 全データモデル型定義（src/types/sake.ts）と固定10種類定義（src/domain/categories.ts）
- 受入確認用サンプルデータ（src/data/sampleData.ts）
- データ検証スクリプト（scripts/verify-data.ts）と npm run verify の確立
- GitHub Actions CI ワークフロー（.github/workflows/verify.yml）
完了条件：npm run verify（data → types → lint → test → build）が exit 0。

### PR #2 feat/step1-domain-logic
ドメインロジックと単体テスト。
- 並び順比較関数、まとめ表示（グループ化）ロジック、横断検索・フィルタリング、開封日数計算
- バックアップ JSON のシリアライズ・スキーマ検証（価格分離の検証を含む）
- ※ 同期マージ（syncMerge）はステップ4の範囲とし、ここでは実装しない

### PR #3 feat/step1-storage-and-state
IndexedDB 永続化レイヤーと状態管理。
- IndexedDB（bottles, photos, meta ストア）の CRUD
- 最小手入力登録・状態変更（ID 生成・更新日時更新・論理削除対応）
- バックアップ書き出し・読み込み処理、サンプルデータ投入機能

### PR #4 feat/step1-ui-views
ステップ1の UI 一式。
- 家にある酒（一覧：写真グリッド・まとめ表示・グループ内展開シート・種類／状態の絞り込み・検索）
- 飲んだ記録（時系列）・画面内切り替えによる手放した酒ビュー
- 下部ナビゲーション（家にある酒／飲んだ記録／登録／データ管理）
- ボトル詳細画面（複数枚写真・属性・解説・購入情報・条件付きの開封日数表示・状態変更）
- 最小手入力登録モーダル／画面、バックアップ書き出し・読み込み UI（タップ領域 44px 以上）
完了条件：サンプルデータで受入条件の全項目を確認できること＋ npm run verify exit 0。

## 5. リポジトリ構成（ステップ0／PR #1〜#4で構築する範囲）

```
sake-collection/
├── .github/
│   └── workflows/
│       └── verify.yml               [PR#1]
├── AGENTS.md                        [Step0]
├── README.md                        [Step0]
├── docs/
│   ├── requirements.md              [Step0]
│   ├── architecture.md              [Step0]
│   └── step1-design.md              [Step0]
├── .gitignore                       [Step0]
├── scripts/
│   └── verify-data.ts               [PR#1]
├── src/
│   ├── types/sake.ts                [PR#1]
│   ├── domain/
│   │   ├── categories.ts            [PR#1]
│   │   ├── sortAndGroup.ts          [PR#2]
│   │   ├── searchAndFilter.ts       [PR#2]
│   │   ├── bottleUtils.ts           [PR#2]
│   │   └── validation.ts            [PR#2]
│   ├── data/sampleData.ts           [PR#1]
│   ├── storage/db.ts                [PR#3]
│   ├── components/                  [PR#4]
│   ├── App.tsx                      [PR#4]
│   └── main.tsx                     [PR#1]
├── tests/                           [PR#2〜]
├── package.json                     [PR#1]
├── tsconfig.json                    [PR#1]
├── eslint.config.js                 [PR#1]
└── vite.config.ts                   [PR#1]
```
※ src/domain/syncMerge.ts と tests/syncMerge.test.ts はステップ4で追加する。

実データ・実写真はリポジトリに入れない。ローカル検証で使う場合はアプリの IndexedDB 内または .gitignore 対象の local-data/ のみに置き、verify-data でも自動検査する。
