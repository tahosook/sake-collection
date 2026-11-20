# sake-collection ワイド画面レイアウト変更 設計書（A案）

作成: Antigravity の Argon（2026-11-20）。
開発ルール: [AGENTS.md](../AGENTS.md) ／ ステップ1設計: [step1-design.md](step1-design.md)

---

## 1. 目的・方針・不変条件

### 目的
iPad や PC などの広い画面で、画面幅を活かした一覧性・閲覧性の高い UI に改善する。現行は全体コンテナが `max-w-md`（448px）固定・在庫グリッドが 2 列固定のため、広い画面では左右に大きな余白が生じている。

### 採用方針（A案）
1. **コンテナ最大幅の拡張**: Tailwind v3 標準の `max-w-6xl`（`1152px`、左右 `px-6` を除いた内側有効幅 **`1104px`** ≒ 目安 1100px）へ拡張する。
2. **一覧グリッドの段階的多列化**: スマホは現行の 2 列を維持し、画面幅に応じて **2 → 3 → 4 → 5 列** へ増やす。
3. **詳細モーダルの 2 ペイン化**: `md`（768px）以上で左に写真ビューア（スクロール追従 sticky）、右に銘柄情報・状態・属性・解説・購入／相場情報を配置する。
4. **ヘッダー・下部ナビの追随**: コンテナと同じ `max-w-6xl` に追随させる。
5. **その他画面の適正幅設計**: 画面の役割に応じて「一覧系はコンテナ全幅＋多列化」「設定・フォーム・ダイアログ系は視線移動が長くなりすぎない適正上限幅」で制御する。

### 変えてはいけないこと（不変条件）
- **スマホ幅（`< 640px`）のレイアウトと操作は現行のまま**（タップ領域 `min-h-touch` / `min-w-touch` = 44px 以上を維持）。
- **データ形式・同期・GAS・ドメインロジックには一切触れない**（変更は `src/App.tsx` および `src/components/` のレイアウト JSX / Tailwind クラスのみ）。
- **並び順・グルーピング・絞り込み・状態表示・開封日数表示などの振る舞いは完全不変**。
- **サムネイルの `object-position`（`object-[50%_90%]`）は完全不変**（`src/components/BottleCard.tsx` / `src/components/BottleHistoryList.tsx`）。
- **完了条件**: 全 PR で `npm run verify`（data → types → lint → test → build）が exit 0 であること。

---

## 2. ブレークポイント・コンテナ幅・列数設計

Tailwind CSS v3.4 の標準ブレークポイントをそのまま採用し、カスタムブレークポイントは増やさない（保守性・既存 `sm:` 記述との整合性のため）。

### 2.1 画面幅別の基準設計（メインシェル・在庫グリッド）

| 区分 | Tailwind 接頭辞 | ビューポート幅 | 想定デバイス | コンテナ最大幅 / 左右余白 | 在庫グリッド列数・間隔 | カード幅目安 |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **スマホ** | （なし） | `< 640px` | iPhone SE〜Pro Max / Android 縦 | 100% / `px-4`（16px） | **2列** / `gap-3`（12px） | 166〜193px（現行不変） |
| **小型タブレット** | `sm:` | `640px〜767px` | iPad mini 縦（744px）/ 大型スマホ横 | 100% / `sm:px-6`（24px） | **3列** / `sm:gap-4`（16px） | 187〜229px |
| **タブレット縦** | `md:` | `768px〜1023px` | iPad / iPad Air / Pro 11" 縦（768〜834px） | 100% / `sm:px-6`（24px） | **4列** / `sm:gap-4`（16px） | 168〜232px |
| **タブレット横・PC** | `lg:` | `1024px〜1279px` | iPad 横（1024〜1194px）/ ノート PC | `max-w-6xl`（1152px） / `sm:px-6` | **5列** / `sm:gap-4`（16px） | 182〜208px |
| **ワイド PC** | `xl:` | `1280px〜` | デスクトップ PC / 外部ディスプレイ | `max-w-6xl`（1152px）中央寄せ | **5列** / `sm:gap-4`（16px） | 208px（固定上限） |

**設計根拠**: すべての画面幅帯で 1 枚あたりのボトルカード幅が **166px〜232px** の適正レンジに収まるため、写真（`aspect-[3/4]`）が間延びせず、バッジ・銘柄名（2行）・本数ラベルも窮屈にならない。PC 画面（1152px 以上）では 5 列×2 行以上（10本以上）を一度に俯瞰できる。

### 2.2 画面・モーダル別の最大幅とレイアウト方針一覧

| 画面 / モーダル | 対象ファイル | `< 640px`（スマホ） | `sm` (640+) | `md` (768+) | `lg` (1024+) | `xl` (1280+) | 設計判断の理由 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ヘッダー** | `App.tsx` | 全幅 (`px-4`) | 全幅 (`px-6`) | 全幅 (`px-6`) | `max-w-6xl` | `max-w-6xl` | コンテナ幅に追随（A案確定） |
| **下部ナビ** | `Navigation.tsx` | 4等分 (`px-1`) | 4等分 (`px-6`) | 4等分 (`px-6`) | `max-w-6xl` | `max-w-6xl` | コンテナ幅に追随（A案確定）。縦積み（アイコン＋ラベル）維持でバッジ重なり防止 |
| **空端末案内バナー** | `App.tsx` | 全幅 | `max-w-md` 中央 | `max-w-md` 中央 | `max-w-md` 中央 | `max-w-md` 中央 | 3つの縦並び CTA ボタンが 1100px に間延びするのを防ぐ |
| **検索・絞り込みバー** | `SearchBar.tsx` | 縦積み＋チップ横スクロール | 縦積み＋チップ横スクロール | **検索＋状態を1行化**＋チップ折り返し | 1行＋チップ1行収まり | 同左 | 縦の占有高を抑えつつ、マウス操作時に横スクロール不要で全10種を選択可能に |
| **家にある酒（在庫）** | `BottleGrid.tsx` | 2列 | 3列 | 4列 | 5列 | 5列 | 写真一覧性を最大化（A案確定） |
| **飲んだ記録 / 手放した酒** | `BottleHistoryList.tsx` | 1列（サブタブ全幅） | 1列 | **2列**（サブタブ `max-w-md`） | **2列** | **2列** | 1列 1100px の間延びを防ぎつつ、時系列の視認性を保つ 2 列（カード幅 354〜544px） |
| **データ管理・設定** | `DataManagementView.tsx` | 1列全幅 | 1列全幅 | **`max-w-3xl`（768px）中央**＋展開内バックアップ/初期化を2列 | 同左 | 同左 | GAS URL 入力欄が見切れず、かつボタンが横に間延びしない適正幅（768px） |
| **詳細モーダル** | `BottleDetailModal.tsx` | 全画面 1ペイン | `max-w-lg` 1ペイン | **`max-w-3xl` 2ペイン（5:7）** | **`max-w-4xl` 2ペイン（5:7）** | **`max-w-5xl` 2ペイン（5:7）** | 写真を見ながら属性・解説・状態操作を閲覧可能に（A案確定） |
| **グループ詳細シート** | `GroupDetailSheet.tsx` | 下部シート 1列 | `max-w-lg` 中央 | `max-w-xl`（576px）中央 | 同左 | 同左 | 個体選択リストは横幅を広げすぎると行内がスカスカになるためコンパクトに維持 |
| **登録・編集フォーム** | `BottleFormModal.tsx` | 全画面 1列 | `max-w-lg` | **`max-w-2xl`（672px）**＋内部2列拡張 | **`max-w-3xl`（768px）**＋内部2列拡張 | 同左 | 登録の順次フロー（写真→Gemini→確認）を崩さず、解説4部・日付欄の2列化で縦スクロール削減 |
| **既存銘柄流用ピッカー** | `ReuseBottlePickerModal.tsx` | 全画面 1列 | `max-w-lg` | `max-w-2xl`（672px）＋種類チップ折り返し | 同左 | 同左 | 長い銘柄名の省略を減らし、一覧選択をしやすくする |
| **Gemini 一括取り込み** | `GeminiBatchImportModal.tsx` | 全画面 1列 | `max-w-2xl` 1列 | `max-w-2xl` 1列 | **`max-w-4xl` 2列グリッド** | 同左 | 最大6本の候補カードを見比べて選択しやすくする |
| **バックアップ復元確認** | `DataManagementView.tsx` | `max-w-md` | `max-w-md` | `max-w-md` | `max-w-md` | `max-w-md` | 確認ダイアログはコンパクト幅を維持（変更なし） |

---

## 3. コンポーネントごとの変更内容

### 3.1 PR 1 対象（メインシェル・一覧・履歴・データ管理）

#### 1. `src/App.tsx`
- **ヘッダー内側コンテナ**: `max-w-md mx-auto px-4 py-3` → `max-w-6xl mx-auto px-4 sm:px-6 py-3`
- **メインコンテナ**: `max-w-md mx-auto p-4 space-y-4` → `max-w-6xl mx-auto p-4 sm:px-6 sm:py-5 space-y-4`
- **データゼロ時の初期案内バナー**: カード div に `max-w-md mx-auto` を追加し、ワイド画面でも中央の適正幅カードを維持する。
- **飲んだ記録 / 手放した酒の切り替えサブタブ**: `md:max-w-md` を追加し、ワイド画面でセグメントボタンが 1100px に引き伸ばされるのを防ぐ。

#### 2. `src/components/Navigation.tsx`
- **ナビ内側コンテナ**: `max-w-md mx-auto grid grid-cols-4 px-1 py-1` → `max-w-6xl mx-auto grid grid-cols-4 px-1 sm:px-6 py-1`
- 各ボタンの縦積みレイアウト（アイコン＋数値バッジ＋ラベル＋下部アクティブバー）と `min-h-touch min-w-touch` は現行のまま維持する。

#### 3. `src/components/SearchBar.tsx`
- **検索入力欄＋状態フィルタ／「また買いたいのみ」トグルの並列化**:
  - 検索入力欄と条件付きフィルタ部をラッパー `<div className="space-y-2.5 md:space-y-0 md:flex md:items-center md:gap-3">` で括る。
  - 検索入力欄ラッパーに `md:flex-1` を付与し、状態フィルタ・また買いたいトグル側に `shrink-0` を付与する。
  - `< 768px` では完全に現行の縦積み（`space-y-2.5`）、`>= 768px` では 1 行に収まる。
- **種類フィルタチップ**:
  - 現行: `overflow-x-auto no-scrollbar -mx-4 px-4 py-1 flex items-center gap-1.5`
  - 変更: `overflow-x-auto no-scrollbar -mx-4 px-4 sm:-mx-6 sm:px-6 md:mx-0 md:px-0 md:overflow-visible md:flex-wrap py-1 flex items-center gap-1.5`
  - `< 640px` は現行通り `-mx-4 px-4` 横スクロール、`sm`（640〜767px）は `main` の `sm:px-6` に合わせた `-mx-6 px-6` 横スクロール、`md` 以上は折り返し表示（`lg` 以上では全11チップが 1 行に収まる）とし、水平オーバーフローを防ぐ。

#### 4. `src/components/BottleGrid.tsx`
- **グリッドクラス**:
  - 現行: `grid grid-cols-2 gap-3 sm:gap-4`
  - 変更: `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4`
- 並び順・グループ受け渡し・空メッセージ表示は不変。

#### 5. `src/components/BottleHistoryList.tsx`
- **リストコンテナ**:
  - 現行: `space-y-2.5`
  - 変更: `grid grid-cols-1 md:grid-cols-2 gap-2.5 md:gap-3.5`
- **各カードボタン**:
  - `min-w-0 h-full` を追加し、CSS Grid トラック内での文字列省略（`truncate` / `line-clamp-1`）の正常動作と行内の高さ揃えを担保する。
- **サムネイル**: `className="w-full h-full object-cover object-[50%_90%]"` は**一切変更しない**。

#### 6. `src/components/DataManagementView.tsx`
- **ルートコンテナ**: `space-y-6` → `max-w-3xl mx-auto space-y-6`
  - ワイド画面で 768px 中央寄せとなり、GAS URL 入力欄や 4 列統計カード（既存の `grid-cols-2 sm:grid-cols-4`）が最も見やすい幅になる。
- **`SyncSection` 内の子カード（バックアップ操作カード＋サンプルデータ初期化カード）**:
  - 2枚のカードを `<div className="grid grid-cols-1 md:grid-cols-2 gap-4">` で括る。`< 768px` は現行と同じ 1 列縦積み、`>= 768px` は 2 列並列表示となる。
- **バックアップ復元確認モーダル**: `max-w-md` をそのまま維持する。

---

### 3.2 PR 2 対象（詳細 2 ペイン＋各種モーダル・シート）

#### 7. `src/components/BottleDetailModal.tsx`
- **モーダル本体幅**:
  - 現行: `w-full max-w-lg h-full h-dvh max-h-dvh sm:h-auto sm:max-h-[92vh] sm:rounded-3xl ...`
  - 変更: `w-full max-w-lg md:max-w-3xl lg:max-w-4xl xl:max-w-5xl h-full h-dvh max-h-dvh sm:h-auto sm:max-h-[92vh] sm:rounded-3xl ...`
- **2ペイン構造**:
  - スクロールコンテナは単一のまま維持（`p-4 sm:p-6 pb-8 sm:pb-6 overflow-y-auto flex-1`）し、直下に 2 ペインラッパーを置く:
    ```tsx
    <div className="space-y-6 md:space-y-0 md:grid md:grid-cols-[5fr_7fr] md:gap-6 lg:gap-8 md:items-start">
      {/* 左ペイン: 写真ビューア（md 以上でスクロール追従） */}
      <div className="space-y-2 min-w-0 md:sticky md:top-0">
        {/* 既存の 1. 写真ビューア（aspect-square + object-contain + サムネイル帯） */}
      </div>

      {/* 右ペイン: 銘柄情報〜購入・相場情報 */}
      <div className="space-y-6 min-w-0">
        {/* 既存の 2. 銘柄名〜7. 購入情報と相場目安 */}
      </div>
    </div>
    ```
  - **重要ポイント**:
    1. **単一スクロール＋左ペイン `md:sticky md:top-0`**: 二重スクロールバーや Safari での `h-auto` 高さ崩れを回避しつつ、写真上にカーソルがあってもホイールで右ペインをスクロールでき、写真が常に視界に残る。
    2. **左右ペイン双方に `min-w-0` を必須付与**: CSS Grid トラックのデフォルト `min-width: auto` により、サムネイル横スクロール帯や長い出典 URL が `5fr` / `7fr` トラック幅を突き破るのを防ぐ。
    3. **`< 768px` での完全不変性**: `space-y-6` の縦積みとなり、現行の DOM 順序・余白と完全一致する。
    4. **写真表示**: メイン写真の `object-contain` とサムネイル切替・代表写真バッジの挙動は不変。
- **モーダルフッター**:
  - `md:justify-end` を追加し、「閉じる」ボタンを `w-full md:w-auto md:min-w-[140px] md:px-6` に調整する（`< 768px` は現行通り全幅）。

#### 8. `src/components/BottleFormModal.tsx`
- **モーダル本体幅**:
  - 現行: `max-w-lg`
  - 変更: `max-w-lg md:max-w-2xl lg:max-w-3xl`
- **状態に関する日付セクション**:
  - 開封日・飲み切り日・手放した日の入力ブロックを `<div className="grid grid-cols-1 md:grid-cols-2 gap-3">` で括り、2 項目表示時（飲み切り／手放した）に横並びにする。
- **お酒の解説 4 部構成**:
  - ①ひとことで〜④おすすめの飲み方の 4 つの `<div>` を `<div className="grid grid-cols-1 md:grid-cols-2 gap-3">` で括る（2×2 配置で縦スクロールを半減）。
- **送信ボタンフッター**:
  - `pt-2 flex gap-3 md:justify-end` とし、キャンセルボタンを `w-1/3 md:w-auto md:px-6`、送信ボタンを `w-2/3 md:w-auto md:min-w-[200px] md:px-6` に調整する（`< 768px` は現行通り 1:2 の全幅）。
- 入力バリデーション・日付クリア仕様・重複警告・Gemini 上書き保護・`PhotoManagerSection`・`GeminiConsultSection` の挙動は完全不変。

#### 9. `src/components/GroupDetailSheet.tsx`
- **モーダル本体幅**: `max-w-lg` → `max-w-lg md:max-w-xl`
- **フッター**: `md:flex md:justify-end` とし、「閉じる」ボタンを `w-full md:w-auto md:min-w-[140px] md:px-6` に調整（`< 768px` は全幅）。
- `< 640px` の下部シート形状（`items-end rounded-t-3xl`）は完全不変。

#### 10. `src/components/ReuseBottlePickerModal.tsx`
- **モーダル本体幅**: `max-w-lg` → `max-w-lg md:max-w-2xl`
- **種類ピルボタン**: `flex gap-1.5 overflow-x-auto pb-1 scrollbar-none` → `flex gap-1.5 overflow-x-auto md:overflow-visible md:flex-wrap pb-1 scrollbar-none`
- **フッター**: `md:flex md:justify-end` とし、キャンセルボタンを `w-full md:w-auto md:min-w-[140px] md:px-6` に調整。

#### 11. `src/components/GeminiBatchImportModal.tsx`
- **モーダル本体幅**: `max-w-2xl` → `max-w-2xl lg:max-w-4xl`
- **各ボトルのプレビューカード一覧**:
  - 現行: `space-y-3`
  - 変更: `grid grid-cols-1 lg:grid-cols-2 gap-3 items-start`
  - 各カード（無効カード・有効カード）に `min-w-0` を付与する。
- **固定フッター**:
  - `md:justify-end` とし、キャンセルを `w-1/3 md:w-auto md:px-6`、一括登録ボタンを `w-2/3 md:w-auto md:min-w-[240px] md:px-6` に調整。

### 3.3 変更不要（明示的に触れないファイル）
- `src/components/BottleCard.tsx`: 現行構造・`aspect-[3/4]`・`object-[50%_90%]` のまま 2〜5 列すべてに適応する。
- `src/components/SyncSection.tsx`: 親（`DataManagementView`）の `max-w-3xl` と `children` グリッドで完結するため変更不要。
- `src/components/PhotoManagerSection.tsx`: 既に `grid-cols-2 sm:grid-cols-3` 対応済みで、`BottleFormModal` 拡張時も 3 列のまま適正サイズになる。
- `src/components/GeminiConsultSection.tsx`: 親幅追従＋背景写り込み注意の位置不変のため変更不要。
- `src/components/Badge.tsx` / `src/components/Icons.tsx`
- `src/domain/*`・`src/storage/*`・`src/services/*`・`src/types/*`・`src/data/*`・`gas/*`・`functions/*`・`scripts/*`（データ・同期・ロジック非変更の不変条件）。

---

## 4. PR 分割案（全 2 PR）と設計条件チェックリスト

変更を「ページ本体（シェル・一覧系）」と「モーダル・オーバーレイ系（詳細2ペイン含む）」の 2 PR に分割する。いずれも最新 `main` からブランチを切り、単独で `npm run verify` exit 0 を満たす。

| PR | ブランチ名 | 概要 | 対象ファイル |
| :-: | :--- | :--- | :--- |
| **PR 1** | `feat/wide-layout-shell-and-lists` | 設計書配置＋コンテナ拡張・ヘッダー/ナビ追随・検索バー・在庫多列グリッド・履歴2列化・データ管理適正幅 | `docs/wide-layout-design.md`, `README.md`（文書一覧追記）, `src/App.tsx`, `src/components/Navigation.tsx`, `src/components/SearchBar.tsx`, `src/components/BottleGrid.tsx`, `src/components/BottleHistoryList.tsx`, `src/components/DataManagementView.tsx` |
| **PR 2** | `feat/wide-layout-modals` | 詳細モーダル2ペイン化＋フォーム・グループシート・流用ピッカー・一括取り込みモーダルのワイド対応 | `src/components/BottleDetailModal.tsx`, `src/components/BottleFormModal.tsx`, `src/components/GroupDetailSheet.tsx`, `src/components/ReuseBottlePickerModal.tsx`, `src/components/GeminiBatchImportModal.tsx` |

### PR 本文用「設計条件チェックリスト」

> `AGENTS.md` §4 に従い、実装（Flash）は下記のチェックリスト項目を変更せず、各項目に「対応箇所」「検証方法」を記入して PR 本文に含めること。

#### PR 1 チェックリスト（`feat/wide-layout-shell-and-lists`）
- [ ] **コンテナ最大幅**: ヘッダー（`App.tsx`）・メイン（`App.tsx`）・下部ナビ（`Navigation.tsx`）が `max-w-6xl`（1152px、内側 1104px）に統一・追随していること
- [ ] **在庫グリッド多列化**: `BottleGrid.tsx` が `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5` になっていること
- [ ] **検索バーのワイド最適化**: `SearchBar.tsx` が `md:` 以上で検索欄と状態／また買いたいフィルタを横並び、種類チップを折り返し表示とし、全幅帯で横スクロール溢れを起こさないこと
- [ ] **履歴一覧の2列化**: `BottleHistoryList.tsx` が `grid-cols-1 md:grid-cols-2` となり、サブタブ切替が `md:max-w-md` で引き伸ばされないこと
- [ ] **データ管理と空バナーの適正幅**: `DataManagementView.tsx` が `max-w-3xl mx-auto`（展開内バックアップ／初期化カードは `md:grid-cols-2`）、空端末案内バナーが `max-w-md mx-auto`、復元確認モーダルが `max-w-md` 維持であること
- [ ] **スマホ幅（`< 640px`）不変**: スマホ幅での列数（在庫2列・履歴1列）・余白・操作感・タップ領域 44px 以上が現行と同一であること
- [ ] **サムネイル `object-position` 不変**: `BottleCard.tsx`（未変更）および `BottleHistoryList.tsx` の `object-[50%_90%]` が変更されていないこと
- [ ] **非レイアウト領域不変**: `src/domain/`・`src/storage/`・`src/services/`・`src/types/`・`gas/` に差分がなく、並び順・グルーピング・状態表示・同期処理が不変であること
- [ ] **標準検証**: `npm run verify`（data / types / lint / test / build）が exit 0 であること

#### PR 2 チェックリスト（`feat/wide-layout-modals`）
- [ ] **詳細モーダル2ペイン化**: `BottleDetailModal.tsx` が `md:` 以上で `max-w-3xl` / `lg:max-w-4xl` / `xl:max-w-5xl` かつ `5fr:7fr` の 2 ペイン（左＝写真ビューア `md:sticky md:top-0`、右＝銘柄〜相場情報）となり、左右ペイン双方に `min-w-0` が付いていること
- [ ] **登録・編集フォームの適正拡張**: `BottleFormModal.tsx` が `md:max-w-2xl lg:max-w-3xl` となり、4部解説と状態日付欄が `md:grid-cols-2`、フッターボタンが `md:` 以上で右寄せ適正幅になっていること
- [ ] **その他モーダルの適正幅**: `GroupDetailSheet.tsx` が `md:max-w-xl`、`ReuseBottlePickerModal.tsx` が `md:max-w-2xl`（種類チップ `md:flex-wrap`）、`GeminiBatchImportModal.tsx` が `lg:max-w-4xl`（候補カード `lg:grid-cols-2`）になっていること
- [ ] **スマホ幅（`< 640px`）不変**: 全モーダルでスマホ幅時の全画面表示（`h-dvh`）／下部シート表示（`GroupDetailSheet`）・1ペイン構成・タップ領域 44px 以上が現行と同一であること
- [ ] **既存機能・制約の維持**: 複数写真切替・状態変更・開封日数表示・背景写り込み注意表示・価格分離表示・写真切り抜き一括取り込みがすべて現行通り動作すること
- [ ] **非レイアウト領域不変**: `src/domain/`・`src/storage/`・`src/services/`・`src/types/`・`gas/` に差分がないこと
- [ ] **標準検証**: `npm run verify`（data / types / lint / test / build）が exit 0 であること

---

## 5. 受け入れ条件（実機・ブラウザ幅別確認）

サンプルデータ（14本）を読み込んだ状態で、以下の各画面幅で確認する（実データでのスクリーンショット撮影は `AGENTS.md` §6 に従い禁止）。

### 5.1 幅別の表示確認マトリクス

| 確認幅 | 想定環境 | 一覧（家にある酒） | 検索バー | 詳細モーダル | 履歴一覧 | データ管理 | フォーム・その他モーダル |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **375px / 390px** | iPhone 縦 | **2列**、現行と完全一致。写真下部基準（`50% 90%`）維持 | 縦積み＋種類チップ横スクロール（ページ横溢れなし） | 全画面 1ペイン、写真→情報の縦並び | 1列、現行と完全一致 | 1列、現行と完全一致 | 全画面 1列／グループ詳細のみ下部シート |
| **640px / 744px** | 小型タブレット・iPad mini 縦 | **3列**、左右余白 `24px` | 縦積み＋種類チップ横スクロール（左右端まで自然に揃う） | 中央モーダル（512px）1ペイン | 1列 | 1列（統計は4列） | 512px 中央モーダル |
| **768px / 820px** | iPad / Air 縦 | **4列**、ヘッダー・下部ナビも全幅追随 | **検索欄＋状態フィルタが1行**、種類チップが折り返し全表示 | **2ペイン（768px、左写真 sticky・右情報）**、スクロールしても写真が残る | **2列**、サブタブは `max-w-md` | 768px 中央、展開内バックアップ／初期化が2列 | フォーム 672px（解説4部2列）、グループ 576px、流用 672px |
| **1024px** | iPad 横 / 小型ノート | **5列**、カード幅約182px | 検索＋状態が1行、種類チップ全11種が1行に収まる | **2ペイン（896px）**、写真複数枚のサムネイル帯が左ペイン内に収まる | **2列** | 768px 中央 | フォーム 768px、一括取り込み **896px・候補2列** |
| **1280px / 1440px** | PC ワイド | **5列**、コンテナ `1152px` 中央寄せ。ヘッダー・下部ナビの左右端が本文と揃う | 同上（コンテナ幅に揃う） | **2ペイン（1024px）**、閉じるボタン右寄せ適正幅 | **2列**、カード高さが揃い視認性良好 | 768px 中央、復元確認ダイアログはコンパクト（448px） | 同上、空端末案内バナーも中央 448px で間延びしない |

### 5.2 共通受け入れ条件
1. すべての確認幅で **意図しないページ全体の横スクロール（`document.documentElement.scrollWidth > window.innerWidth`）が発生しない** こと。
2. 詳細モーダル（2ペイン時）で、複数写真（2〜3枚）を持つボトル・長い解説や出典 URL を持つボトルを開いた際、左ペインのサムネイル帯や右ペインの URL が列幅を突き破らず、状態変更フォームを展開してもレイアウトが崩れないこと。
3. 複数本グループ（例：同一銘柄 2 本）をタップ → `GroupDetailSheet` → 個体選択 → `BottleDetailModal` の遷移、および詳細から「編集」→ `BottleFormModal` の遷移が全幅帯で正常に動作すること。
4. 在庫の並び順（開封済み＞未開封 → 種類順 → 購入日降順）、ワインのヴィンテージ別グループ化、開封日数の詳細限定表示、購入価格と相場目安の分離表示が現行と一切変わらないこと。
5. `npm run verify` が exit 0 で完了すること。
