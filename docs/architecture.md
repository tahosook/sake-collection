# sake-collection 全体設計書

作成: Antigravity の Argon（会話「Sake Collection App Design」、2026-11-08）。Muse の3点レビューを反映した改訂版に基づく。
要件の正本は docs/requirements.md、開発ルールは AGENTS.md。
本書はステップ1〜4を通じた全体設計（データ構造・写真管理・同期方式・画面構成）を確定する。ステップ2〜4の詳細設計と受入条件は、各ステップの開始時に別途策定する。

## 1. 技術構成

- TypeScript 5.x (strict) + React 18 + Vite（ローカルファースト PWA）
- Tailwind CSS。モバイルファースト、タップ対象 44px 以上
- ローカル DB：IndexedDB（idb ラッパー）。ボトルレコード・複数枚の写真・同期メタデータを保持
- スキーマ・データ検証：純粋 TypeScript バリデータ（または zod）
- 画像処理：Canvas API。リサイズ（長辺最大 1600px 目安）・JPEG/WebP 圧縮・EXIF 完全除去
- テスト・品質検証：Vitest + ESLint + TypeScript (tsc --noEmit)
- 同期バックエンド：Google Apps Script (GAS Web App) + Google Sheets + Google Drive
- ホスティング・認証：Cloudflare Pages + Cloudflare Access（本番・プレビュー両方。本人の Google アカウントのみ許可）

## 2. データモデル（ステップ1〜4共通・確定版）

スキーマの破壊的変更を避けるため、同期・複数写真・解説・相場目安を含む全データ構造を初期時点で確定する。

### 種類（固定・配列順が並び順）
```ts
export const SAKE_CATEGORIES = ['日本酒','ワイン','ウイスキー','ジン','焼酎','ビール','ブランデー','シェリー','ウォッカ','その他'] as const;
```

### 状態
```ts
export const BOTTLE_STATUSES = ['unopened', 'opened', 'finished', 'disposed'] as const; // 未開封 / 開封済み / 飲み切り / 手放した
```
- 一覧（いま家にある酒）：status が unopened / opened（かつ deleted でない）
- 飲んだ記録（時系列）：finished（かつ deleted でない）
- 手放した一覧：disposed（かつ deleted でない。飲んだ記録とは分離）

### 種類別追加属性（最小限）
- 日本酒：brewery（蔵元）、ricePolishingRatio（精米歩合）、specificName（特定名称）
- ワイン：grapeVarieties（品種）、region（産地）、wineType（タイプ）、vintageYear（年。まとめ表示の別銘柄判定に使用）
- ウイスキー：distillery（蒸留所）、ageStatement（熟成年数）
- ジン：distillery（蒸留所）、botanicals（主なボタニカル）
- 焼酎：ingredients（原材料）、brewery（蔵元）
- ビール：beerStyle（スタイル）、brewery（醸造所）
- ブランデー：region（産地）、grade（等級）
- シェリー：sherryType（タイプ）、bodega（ボデガ）
- ウォッカ：ingredients（原料）、region（産地）
- その他：追加属性なし

### 解説・出典・購入情報・相場目安
```ts
interface SakeDescription { summary: string; tasteProfile: string; background: string; servingSuggestion: string;} // ①ひとことで ②味わい ③背景 ④飲み方
interface DescriptionSource { title?: string; url: string;}
interface PurchaseInfo { purchaseDate: string | null; purchasePlace: string; purchasePriceYen: number | null;}
interface ReferencePriceInfo { estimatedPriceYen: number | null; fetchedDate: string | null; note?: string;}
```
購入価格と相場目安は構造上完全に分離し、混ぜたり上書きしたりしない。

### ボトルレコード（1本＝1レコード）
```ts
interface BottleRecord {
id: string; // UUID
createdAt: string; // ISO 8601 UTC（購入日未入力時の並び代用にも使う）
updatedAt: string; // ISO 8601 UTC（同期マージの比較基準）
deleted: boolean; // 論理削除フラグ
name: string; // 必須
category: SakeCategory; // 必須
abv: number | null; // 度数（%）
volumeMl: number | null; // 容量（ml）
categoryAttributes: CategoryAttributes;
status: BottleStatus;
openedDate: string | null; // 未開封のときは必ず null
finishedDate: string | null; // 未開封のときは必ず null
disposedDate: string | null; // 未開封のときは必ず null
tastingNote: string; // 感想メモ（1本に1つ、上書き形式）
wantToBuyAgain: boolean; // 「また買いたい」の印
description: SakeDescription | null;
sources: DescriptionSource[];
purchaseInfo: PurchaseInfo;
referencePrice: ReferencePriceInfo | null;
photoIds: string[]; // 紐づく PhotoRecord.id の順序付き配列
primaryPhotoId: string | null; // 代表写真（未指定時は photoIds[0]）
userEditedFields: string[]; // 再取り込み時に上書きしないフィールド名
}
```

### 写真レコード（ステップ1で型確定・ステップ2〜4で運用）
```ts
interface PhotoRecord {
id: string; // UUID
bottleId: string;
mimeType: 'image/jpeg' | 'image/webp';
dataUrl: string; // リサイズ・EXIF 除去済み（IndexedDB 保持・バックアップ・Drive 転送用）
width: number; height: number; byteSize: number;
contentHash: string; // SHA-256 hex（重複転送防止・同一性確認）
driveFileId: string | null; // ステップ4で Drive 保存後に設定
createdAt: string; updatedAt: string;
deleted: boolean;
}
```

## 3. まとめ表示（グループ化）と並び順

### 1本単位の並び順 compareBottles
1. 状態：opened（開封済み）を先、unopened（未開封）を後
2. 種類の記載順（SAKE_CATEGORIES のインデックス昇順）
3. 有効購入日の新しい順。有効購入日 = purchaseDate?? createdAt の日付
4. タイブレーク：createdAt 降順 → id 辞書順

### グループ化（表示時の純粋関数で計算。データは1本単位のまま）
- 対象：deleted でなく status が unopened / opened のボトル。種類フィルタ・状態フィルタ・検索を先に1本単位で適用し、表示本数は絞り込み後の数とする（飲み切り・手放したは含めない）
- 同一銘柄キー：正規化名（前後空白除去＋連続空白を1つに）＋ 種類 ＋ 容量（null は 'unknown'）＋ ヴィンテージ（ワインのみ。null は 'nv'）
- グループの属性：最優先状態（opened が1本でもあれば opened）、最新購入日（グループ内の有効購入日の最大値）、代表写真（先頭ボトルの代表写真、なければグループ内で写真を持つ最初のボトルの代表写真）
- グループ間の並び：①最優先状態 ②種類順 ③最新購入日の新しい順 ④先頭ボトルの createdAt 降順 → groupKey 辞書順
- 1本のグループはタップで直接詳細へ。2本以上は本数バッジを表示し、タップで個体リスト（シート）を開いて1本ずつ詳細へ

### 検索
- 対象は「いま家にある酒」と「飲んだ記録」の両方（手放した酒は「飲んだ記録」画面内の切り替えで確認可能とする）
- 対象フィールド：名前、蔵元、蒸留所、醸造所、ボデガ、産地、品種、特定名称、スタイル、タイプ、主なボタニカル、原材料・原料、等級

## 4. 写真保存・Drive 連携・同期方式（設計確定・実装はステップ2／4）

開発ルールに従い、データモデルはステップ1の設計で同期前提に確定させるが、同期処理・同期マージ（syncMerge）のコード実装とその単体テストはステップ4まで入れない。

### 写真保存の仕組み（ステップ2でローカル実装・ステップ4で Drive 連携）
- 登録・編集時に選択された画像は、端末内の Canvas で長辺最大 1600px にリサイズし JPEG（品質 0.82 目安）に再エンコードすることで EXIF を完全に除去する
- 端末内では IndexedDB の photos ストアに PhotoRecord として保存する
- ステップ4の同期時には、Google Drive の本人専用・非公開フォルダ（共有リンク無効）に写真の実体ファイルを保存し、Sheets の Photos シートにはメタデータ（id, bottleId, driveFileId, contentHash, updatedAt, deleted）のみを記録する
- 写真の取得も公開 URL ではなく、合言葉認証を通した GAS 経由とする

### 同期・競合解決・初回同期・冪等性（ステップ4で実装）
- トリガー：「今すぐ同期」ボタンの手動実行のみ
- 競合解決：id ごとに updatedAt を比較し、新しい方を採用する（最終更新優先）
- 論理削除の伝播：削除は deleted = true ＋ updatedAt 更新として記録し、同期で伝播させる
- 空・初期状態の端末からの初回同期保護：ローカルレコード0件の端末は「ローカル変更0件・lastSyncAt = null」としてリクエストを送り、同期先の既存データを消さず、Sheets と Drive の全データを IndexedDB へ復元する
- 冪等性と再試行：UUID と contentHash により、同じリクエストの再送で二重登録にならない。写真のアップロード・ダウンロードはチャンク単位で順次処理し、途中失敗時は未完了分から再試行できる

### セキュリティと Smart Closet との完全分離
- GAS の認可は Cloudflare Access とは別に、合言葉（ユーザーが入力し、端末の設定領域にのみ保持）をリクエストに含め、GAS 側の ScriptProperties と照合して不一致・空欄なら即拒否（fail-closed）
- リポジトリ・ビルド成果物・フロントエンドコードに、GAS の URL・合言葉・シート ID・Drive フォルダ ID の平文を含めない
- Smart Closet とは、GitHub リポジトリ・Google Drive フォルダ・Google Sheets・GAS プロジェクト・Cloudflare Pages プロジェクト・Cloudflare Access アプリケーションをすべて別個に作成し、混在しないことをチェックリストで確認する

## 5. 画面構成と遷移（全体）

下部ナビゲーション（4タブ）＋モーダル／詳細ビューで構成する。

- 家にある酒（一覧）：写真グリッド、まとめ表示、種類・状態の絞り込み、横断検索
- 飲んだ記録：飲み切りの時系列一覧と、画面内切り替えによる手放した酒の一覧
- 登録：下部ナビゲーションからいつでも起動できる手入力・写真登録モーダル
- データ管理・設定：JSON バックアップの書き出し・読み込み、サンプルデータ投入、GAS 同期操作
- 同一銘柄一覧シート：グループ内の個体を確認して詳細へ
- ボトル詳細：写真全枚、属性、開封日欄での開封日数補助表示（条件付き）、解説と出典、購入情報、相場目安、状態変更
- 登録・編集（モーダル）：最小手入力、複数写真・Gemini JSON 取り込み・同銘柄流用・複数本登録
