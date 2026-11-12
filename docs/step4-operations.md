# sake-collection 公開・運用手順書

作成日: 2026-11-10
対象: ステップ4（クラウド同期と本人限定公開）
正本設計書: `docs/step3-4-design.md`

本書は、sake-collection のクラウド同期バックエンド（Google Drive / Sheets / GAS）およびホスティング・アクセス制御（Cloudflare Pages + Access）の初期構築、公開設定、受入確認、完全分離検証、および日常の運用・保守手順を定める正本手順書です。

> [!CAUTION]
> **秘匿情報・個人情報の取り扱いに関する厳守事項**
> 本リポジトリは公開（Public）です。本書内の手順を実行する際、個人のメールアドレス、Google リソースの実 ID、実際の合言葉（Passphrase）、GAS デプロイ URL の実値をコミットしたり、PR 本文・Issue・ログに出力したりすることは絶対に避けてください。本書中ではすべて `<...>` 形式のプレースホルダで表記しています。

---

## 目次

1. [全体アーキテクチャとセキュリティ境界](#1-全体アーキテクチャとセキュリティ境界)
2. [Google 側バックエンドリソースの構築手順](#2-google-側バックエンドリソースの構築手順)
   - [2.1 Google Drive フォルダの作成](#21-google-drive-フォルダの作成)
   - [2.2 Google スプレッドシートの作成](#22-google-スプレッドシートの作成)
   - [2.3 Google Apps Script (GAS) の作成と設定](#23-google-apps-script-gas-の作成と設定)
   - [2.4 GAS Web アプリのデプロイ](#24-gas-web-アプリのデプロイ)
3. [Cloudflare Pages + Access の公開手順](#3-cloudflare-pages--access-の公開手順)
   - [3.1 Cloudflare Pages プロジェクトの作成](#31-cloudflare-pages-プロジェクトの作成)
   - [3.2 Cloudflare Access（Zero Trust）の設定](#32-cloudflare-accesszero-trustの設定)
   - [3.3 Pages Secret 環境変数の登録](#33-pages-secret-環境変数の登録)
   - [3.4 Access 保護と設定自動取得の疎通確認](#34-access-保護と設定自動取得の疎通確認)
4. [先行アプリとの完全分離チェックリスト（6項目）](#4-先行アプリとの完全分離チェックリスト6項目)
5. [ステップ4 受入確認手順（設計書 §7）](#5-ステップ4-受入確認手順設計書-7)
6. [日常運用・保守ガイド](#6-日常運用保守ガイド)
   - [6.1 同期の基本操作](#61-同期の基本操作)
   - [6.2 バックアップとリストア](#62-バックアップとリストア)
   - [6.3 合言葉（パスフレーズ）の変更手順](#63-合言葉パスフレーズの変更手順)
   - [6.4 GAS コードの更新手順（再デプロイ）](#64-gas-コードの更新手順再デプロイ)
   - [6.5 トラブルシューティング（FAQ）](#65-トラブルシューティングfaq)

---

## 1. 全体アーキテクチャとセキュリティ境界

sake-collection は、端末内 IndexedDB を正本とする**ローカルファースト PWA** です。複数端末間のデータ同期と写真のバックアップのために、Google Workspace（Sheets / Drive / GAS）と Cloudflare（Pages / Access / Functions）を組み合わせたゼロトラスト構成を採用しています。

```mermaid
flowchart TD
    subgraph Client["クライアント端末（PC / スマホ PWA）"]
        IDB[("端末内 IndexedDB\n(正本データ + 写真)")]
        UI["sake-collection UI\n(今すぐ同期 / 復元)"]
        SyncClient["Sync Orchestrator\n(4フェーズ同期)"]
        UI --> SyncClient
        SyncClient <--> IDB
    end

    subgraph CF["Cloudflare (本人限定公開境界)"]
        Pages["Cloudflare Pages\n(静的ホスティング: HTML/JS/CSS)"]
        Access["Cloudflare Access\n(メールログインコード認証・本人のみ許可)"]
        Func["Pages Functions\nGET /api/sync-config"]
        Access --> Pages
        Access --> Func
    end

    subgraph Google["Google Cloud (個人保管領域)"]
        GAS["Google Apps Script\n(sake-collection-sync)"]
        Sheet[("Google Sheets\n(sake-collection-db)")]
        Drive[("Google Drive フォルダ\n(sake-collection-photos)")]
        GAS <--> Sheet
        GAS <--> Drive
    end

    Client -- "① アクセス (メールログインコード認証)" --> Access
    SyncClient -- "② 接続設定自動取得\n(JWT 検証済 fail-closed)" --> Func
    SyncClient -- "③ 同期・画像送受信\n(合言葉 fail-closed POST)" --> GAS
```

### 主要なセキュリティ原則
1. **GitHub 公開リポジトリへの平文非保持**:
   - GAS URL や合言葉などの秘密情報は、ソースコード・ビルド成果物（`dist/`）に一切含めません（`VITE_*` 環境変数の使用禁止）。
2. **多層防御（2つの独立した境界）**:
   - **画面側境界（Cloudflare Access）**: ユーザー本人のメールアドレス宛に送信されるワンタイムログインコード（PIN）による認証。未認証アクセスは Pages Functions も含めて `403 Forbidden` / ログインリダイレクト。
   - **データ側境界（GAS Web アプリ）**: Access を万一バイパスされた場合でも、共有シークレット（`SYNC_PASSPHRASE`）による定数時間比較の fail-closed 認証で保護。
3. **写真の完全非公開保護**:
   - 写真が保存される Google Drive フォルダは「リンクを知っている全員」を禁止（制限付き）とし、GAS 経由でのみ中継・取得されます。

---

## 2. Google 側バックエンドリソースの構築手順

Google アカウントにログインした状態で、以下の手順を順番に実施します。

### 2.1 Google Drive フォルダの作成
酒の写真（リサイズ済み画像）を非公開で保管する専用フォルダを作成します。

1. Google Drive（`https://drive.google.com/`）を開きます。
2. 左上の「＋ 新規」>「新しいフォルダ」をクリックします。
3. フォルダ名に **`sake-collection-photos`** と入力して作成します。
4. 作成したフォルダを右クリックし、「共有」>「共有」を開きます。
5. **一般的なアクセス** が **「制限付き」**（自分のみアクセス可能）になっていることを確認します（「リンクを知っている全員」には絶対にしないでください）。
6. ブラウザのアドレスバーの URL から、フォルダ ID をコピーして安全に控えます。
   - URL 例: `https://drive.google.com/drive/folders/<DRIVE_FOLDER_ID>`

### 2.2 Google スプレッドシートの作成
コレクションのメタデータ（ボトル情報・写真メタ情報・同期メタ情報）を保管する専用スプレッドシートを作成します。

1. Google スプレッドシート（`https://sheets.google.com/`）を開きます。
2. 「空白のスプレッドシート」を作成します。
3. タイトルに **`sake-collection-db`** と入力します。
4. アドレスバーの URL から、スプレッドシート ID をコピーして安全に控えます。
   - URL 例: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`
5. ※シート（`Bottles`, `Photos`, `SyncMeta`）の作成やヘッダーの設定は、初回同期時に GAS が自動作成するため手動での作成は不要です。

### 2.3 Google Apps Script (GAS) の作成と設定
同期 API を処理する Web アプリケーションプロジェクトを作成します。

1. Google Apps Script（`https://script.google.com/`）を開きます。
2. 左上の「新しいプロジェクト」をクリックします。
3. プロジェクト名を **`sake-collection-sync`** に変更します。
4. **マニフェストファイル（`appsscript.json`）の反映**:
   - 左メニューの「プロジェクトの設定」（歯車アイコン）をクリックします。
   - 「「appsscript.json」マニフェスト ファイルをエディタで表示する」にチェックを入れます。
   - 左メニューの「エディタ」（＜＞アイコン）に戻り、`appsscript.json` を開きます。
   - リポジトリ内の `gas/appsscript.json` の内容をコピーして貼り付け、保存します。
5. **コードファイル（`Code.gs`）の反映**:
   - `コード.gs`（または `Code.gs`）を開きます。
   - リポジトリ内の `gas/Code.gs` の内容をすべてコピーして貼り付け、保存します。
6. **スクリプトプロパティの設定**:
   - 左メニューの「プロジェクトの設定」（歯車アイコン）をクリックします。
   - 画面下部の「スクリプト プロパティ」セクションで「スクリプト プロパティを追加」をクリックし、以下の **3つ** のプロパティを登録します。

| プロパティ名 | 値 | 説明 |
| :--- | :--- | :--- |
| `SYNC_PASSPHRASE` | `<強力なランダム合言葉>` | 32文字以上のランダム文字列（例: `openssl rand -hex 24` で生成） |
| `SPREADSHEET_ID` | `<SPREADSHEET_ID>` | 手順 2.2 で控えたスプレッドシート ID |
| `DRIVE_FOLDER_ID` | `<DRIVE_FOLDER_ID>` | 手順 2.1 で控えた Google Drive フォルダ ID |

### 2.4 GAS Web アプリのデプロイ
1. エディタ右上の「デプロイ」>「新しいデプロイ」をクリックします。
2. 種類の選択（歯車アイコン）で **「ウェブアプリ」** を選択します。
3. 設定項目を以下のように入力します：
   - **説明**: `sake-collection sync backend v1`
   - **次のユーザーとして実行**: **「自分」**（あなたの Google アカウント）
   - **アクセスできるユーザー**: **「全員」**（Anyone）
     - ※アクセス制御は GAS 側のコード内で `SYNC_PASSPHRASE` による fail-closed 認証（定数時間比較）で行われます。
4. 「デプロイ」をクリックします。
5. 初回デプロイ時は「アクセスを承認」画面が表示されるため、自分のアカウントを選択し、警告画面が出た場合は「詳細」>「sake-collection-sync（安全ではないページ）に移動」をクリックして権限を承認します。
6. デプロイ完了画面に表示される **ウェブアプリ URL** をコピーして安全に控えます。
   - URL 形式: `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`

---

## 3. Cloudflare Pages + Access の公開手順

Cloudflare ダッシュボードにログインし、本番およびプレビュー環境のホスティングとアクセス制御を構築します。

### 3.1 Cloudflare Pages プロジェクトの作成
1. Cloudflare ダッシュボード > **Workers & Pages** > **Create application** > **Pages** タブ > **Connect to Git** をクリックします。
2. GitHub アカウントを連携し、リポジトリ **`tahosook/sake-collection`** を選択します。
3. ビルド構成を以下のように設定します：
   - **Project name**: `sake-collection`
   - **Production branch**: `main`
   - **Framework preset**: `None`（または `Vite`）
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. ※環境変数（Secrets）はこの段階では登録せず、まずは「Save and Deploy」をクリックして初回のビルド・デプロイを走らせます。
5. デプロイ完了後、割り当てられたドメイン（`https://sake-collection-cs2.pages.dev`）を確認します。

### 3.2 Cloudflare Access（Zero Trust）の設定
本番環境（`sake-collection-cs2.pages.dev`）およびすべてのプレビュー環境（`*.sake-collection-cs2.pages.dev`）を、Cloudflare Access による本人限定アクセスで保護します。実際の構成として、**本番用（手動作成）とプレビュー用（Pages 自動生成）の2件の Access Application** を設定・運用します。

1. **本番用 Access Application の手動作成（apex ドメイン用）**:
   - Zero Trust ダッシュボード > **Access** > **Applications** を開きます。
   - **「Add an application」** > **「Self-hosted」** を選択します。
   - **Application configuration**:
     - **Application name**: `sake-collection-production`（任意の識別名）
     - **Application domain**: `sake-collection-cs2.pages.dev`
   - **Policies**:
     - **Policy name**: `Allow Owner Only`
     - **Action**: `Allow`
     - **Configure rules**:
       - **Selector**: `Emails`
       - **Value**: `<本人のメールアドレス>`（リポジトリには実アドレスを記載せず Cloudflare 側で設定）
   - 保存してアプリケーションを作成します。

2. **プレビュー用 Access Application の生成（Pages 設定）**:
   - Cloudflare ダッシュボード > **Workers & Pages** > **`sake-collection`** を開きます。
   - **Settings** > **General** を開き、画面下部の **Access policy** セクションまでスクロールします。
   - **「Enable access policy」**（プレビューデプロイへのアクセス制御）をクリックして有効化します。
   - ※これにより、Zero Trust 側にプレビュー用の Access Application（Application domain: `*.sake-collection-cs2.pages.dev`）が自動生成されます。
   - Zero Trust > **Access** > **Applications** を開き、自動生成されたプレビュー用 Application の Policies にて、本番用と同様に本人メールアドレス限定の Allow ポリシー（Selector: `Emails`、Value: `<本人のメールアドレス>`）が適用されていることを確認します。

3. **認証（ログイン）方式の実態（メール宛ログインコード送信方式）**:
   - Cloudflare Access の認証画面は、メールアドレスを入力するとワンタイムログインコード（PIN）がメール送信され、そのコードを入力して認証する方式（One-time PIN）となります（Google ログインボタンは表示されません）。

4. **Audience Tag (AUD) の取得（環境ごとに別値）**:
   - AUD は Application ごとに別々の値となります。本番用 Application（apex）の AUD と、プレビュー用 Application の AUD の両方を控えます。
   - Zero Trust > **Access** > **Applications** から、本番用 Application（`sake-collection-cs2.pages.dev`）およびプレビュー用 Application（`*.sake-collection-cs2.pages.dev`）それぞれの **Overview** 画面を開き、表示されている Audience Tag（AUD）文字列をコピーして安全に控えます。

5. **チームドメイン（Team Domain）の確認**:
   - Zero Trust > Settings > Custom Pages または Overview から、自組織のチームドメインを確認して控えます。
   - 例: `<your-team-name>.cloudflareaccess.com`

### 3.3 Pages Secret 環境変数の登録
Pages Functions（`/api/sync-config`）が Access JWT の完全検証を行い、GAS URL と合言葉を安全にクライアントへ返すための環境変数を設定します。
実装（`functions/api/sync-config.ts`）は環境ごとに単一の AUD を検証する仕様となっているため、`SAKE_ACCESS_AUD` は環境ごとにその環境に対応する Application の AUD を登録します（Production 環境には本番用 Application の AUD、Preview 環境にはプレビュー用 Application の AUD）。

1. Cloudflare ダッシュボード > **Workers & Pages** > **`sake-collection`** を開きます。
2. **Settings** > **Environment variables** を開きます。
3. 以下の環境変数を **Encrypt（Secret）** として登録します。

| 変数名 | タイプ | 設定する値 | 対象環境 |
| :--- | :---: | :--- | :--- |
| `SAKE_GAS_URL` | Secret | 手順 2.4 で控えた GAS ウェブアプリ URL (`https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`) | **Production と Preview の両方** |
| `SAKE_GAS_PASSPHRASE` | Secret | 手順 2.3 で設定した `SYNC_PASSPHRASE` と同一の文字列 | **Production と Preview の両方** |
| `SAKE_ACCESS_TEAM_DOMAIN` | Secret | 手順 3.2 で確認したチームドメイン (`<your-team-name>.cloudflareaccess.com`) | **Production と Preview の両方** |
| `SAKE_ACCESS_AUD` | Secret | 手順 3.2 で控えた本番用 Application（apex 用）の AUD | **Production 環境のみ** |
| `SAKE_ACCESS_AUD` | Secret | 手順 3.2 で控えたプレビュー用 Application（`*.sake-collection-cs2.pages.dev` 用）の AUD | **Preview 環境のみ** |

※Cloudflare Pages の Environment variables 画面では、変数ごとに「Production」と「Preview」で個別の値を登録できます。`SAKE_GAS_URL`, `SAKE_GAS_PASSPHRASE`, `SAKE_ACCESS_TEAM_DOMAIN` の3点は両環境共通の値を設定し、`SAKE_ACCESS_AUD` のみそれぞれの環境に対応する AUD を登録してください。

4. 設定保存後、最新のデプロイメントに対して **「Retry deployment」**（再デプロイ）を実行し、環境変数を反映させます。

### 3.4 Access 保護と設定自動取得の疎通確認
本番 URL とハッシュ付き個別 Preview URL の両方で、未認証アクセスが確実に遮断され、本人のみアクセスできることを確認します。

1. **未認証アクセスの遮断確認（本番 URL およびハッシュ付き Preview URL）**:
   - Cloudflare Pages の **Deployments** 一覧から、直近のプレビューデプロイの個別ハッシュ付き URL（例: `https://<deployment-hash>.sake-collection-cs2.pages.dev`）をコピーします。
   - ブラウザのシークレットウィンドウを開き、以下の2つの URL に順にアクセスします：
     - 本番 URL: `https://sake-collection-cs2.pages.dev`
     - ハッシュ付き Preview URL: `https://<deployment-hash>.sake-collection-cs2.pages.dev`
   - 両方の URL で、ページ本体が表示されることなく即座に Cloudflare Access の認証画面（メールアドレス入力画面）へリダイレクトされることを確認します。
   - 許可されていない別のアドレスを入力してログインコード送信を試みてもコードが届かない、またはコード認証でアクセスが拒否（403 Forbidden または Access Denied）されることを確認します。
2. **本人ログインと自動設定取得の確認**:
   - 本人のメールアドレスを入力して受信したワンタイムログインコードを入力し、sake-collection のメイン画面が表示されることを確認します（本番 URL および Preview URL の両方）。
   - 画面下部「データ管理」タブを開き、最上部の同期カードのバッジが **「接続可能」**（緑色）になっていることを確認します。
   - 「⚙️ 同期設定・バックアップ・初期化を開く」を展開し、同期接続設定のステータスが **「自動取得済」**（緑色）になっていることを確認します。
   - 「接続テスト (ping)」ボタンをクリックし、**「接続成功！（サーバー上: ボトル X本、写真 Y枚）」** と表示されることを確認します。

> **実地確認実績（2026-11-11）**:
> 本構成（本番手動 Self-hosted＋プレビュー Pages 自動生成、環境別 AUD、メール宛ワンタイムログインコード認証）にて、実データを用いた新規登録 →「今すぐ同期」→ 空のブラウザ（スマートフォン）からの復元までの一連のフローが正常に完了することを確認済みです。

---

## 4. 先行アプリとの完全分離チェックリスト（6項目）

本プロジェクトは先行する Smart Closet のアーキテクチャを踏襲していますが、データ・認証・クラウドインフラは完全に独立しています。運用開始前に、以下の6項目がすべて独立していることを目視・設定値で確認します。

| # | 検査項目 | 確認内容 | 判定 |
| :-: | :--- | :--- | :-: |
| 1 | **Git リポジトリ** | GitHub 上のリポジトリが `tahosook/sake-collection` であり、コミット履歴・ブランチが完全に分離していること。 | [ ] 独立確認 |
| 2 | **Google Drive フォルダ** | フォルダ名が `sake-collection-photos` であり、固有のフォルダ ID を持ち、共有設定が「制限付き」であること。他アプリのフォルダと一切混同していないこと。 | [ ] 独立確認 |
| 3 | **Google スプレッドシート** | ファイル名が `sake-collection-db` であり、固有のシート ID を持つこと。他アプリのシートと共有していないこと。 | [ ] 独立確認 |
| 4 | **GAS プロジェクト** | プロジェクト名が `sake-collection-sync` であり、固有のデプロイ URL を持つこと。スクリプトプロパティの合言葉・各リソース ID が専用のものであること。 | [ ] 独立確認 |
| 5 | **Cloudflare Pages** | プロジェクト名が `sake-collection` であり、`sake-collection-cs2.pages.dev` で稼働していること。環境変数が `SAKE_*` プレフィックスで管理されていること。 | [ ] 独立確認 |
| 6 | **Cloudflare Access** | `sake-collection-cs2.pages.dev` 用の手動作成 Application と `*.sake-collection-cs2.pages.dev` 用の Pages 生成 Application の2件であり、対象ドメインが本番および個別プレビュー URL に限定され、他アプリと分離した固有の AUD（本番・プレビューそれぞれ別値）を持っていること。 | [ ] 独立確認 |

---

## 5. ステップ4 受入確認手順（設計書 §7）

すべてのリソースが構築された後、設計書 §7 に定める以下の受入シナリオを実施します。

### シナリオ 1: 本人限定アクセスの確認（本番 URL およびハッシュ付き Preview URL）
1. Cloudflare Pages のデプロイ一覧から、ハッシュ付きの個別 Preview URL（`https://<deployment-hash>.sake-collection-cs2.pages.dev`）を取得します。
2. シークレットウィンドウを開き、本番 URL（`https://sake-collection-cs2.pages.dev`）およびハッシュ付き Preview URL の両方に未認証でアクセスします。
3. いずれの URL でもコンテンツが表示されず、即座に Cloudflare Access の認証画面（メールアドレス入力画面）へリダイレクトされることを確認します。
4. 許可リストに含まれない別のアカウント・アドレスでログインを試みてもアクセスが拒否されることを確認します。
5. 本人のメールアドレス宛に届いたワンタイムログインコードで認証し、本番・Preview の両方で正常にアプリが表示されることを確認します。

### シナリオ 2: 飲んだ記録での「また買いたい」絞り込み確認
1. アプリ上で「飲んだ記録」タブを開きます。
2. 検索バーの下にある「また買いたいのみ」（SVG ハート付きチップ）をタップして ON にします。
3. `wantToBuyAgain: true` のボトルのみが表示され、種類フィルタやテキスト検索と掛け合わせても正しく動作することを確認します。
4. ボトル詳細モーダルの状態変更パネルを開き、日付の手修正や空欄化（クリア）が正常に保存できることを確認します。

### シナリオ 3: 初回同期（PC 端末からクラウドへ）
1. PC ブラウザ（ログイン済み）で酒のデータを新規登録します（カメラまたはファイルから写真を1枚以上添付）。
2. 「データ管理」タブの「今すぐ同期」ボタンをクリックします。
3. 進捗バーが進み、「ボトル情報を同期中...」→「写真を送信中 (1/1)...」→「データを確定中...」を経て「同期が完了しました」と表示されることを確認します。
4. Google スプレッドシート（`sake-collection-db`）を開き、`Bottles`, `Photos`, `SyncMeta` シートが作成され、登録したボトルと写真のメタデータが記録されていることを確認します。
5. Google Drive（`sake-collection-photos`）を開き、アップロードされた画像ファイルが作成されていることを確認します。

### シナリオ 4: 新規空端末からのワンタップ完全復元（スマホ受入確認）
1. スマートフォン（iPhone / Android）のブラウザで `https://sake-collection-cs2.pages.dev` を開きます。
2. Cloudflare Access の認証画面が表示されるので、本人のメールアドレス宛に届いたワンタイムログインコードでログインします。
3. データ0件の状態で開くと、トップ画面最上部に **「クラウドからデータを復元（今すぐ同期）」** の目立つ案内バナーが表示されていることを確認します。
4. バナー内のボタンをタップします。
5. 同期オーケストレーターが自動的に設定を取得し、Google 側からボトルデータと写真を一括ダウンロードして IndexedDB に復元することを確認します。
6. 復元完了後、PC 側で登録したお酒の一覧・写真がスマートフォン上でも鮮明に表示されることを確認します。

### シナリオ 5: 写真差し替え・削除時の双方向整合と Drive ゴミ箱移動
1. PC 端末で登録済みボトルの詳細を開き、「編集」から添付写真を削除（または別写真に差し替え）して保存します。
2. 「今すぐ同期」を実行します。
3. Google Drive のゴミ箱を確認し、外された古い写真ファイルが Drive のゴミ箱（`setTrashed(true)`）に移動していることを確認します。
4. 「データ管理」>「バックアップを書き出す（JSON）」を実行し、出力された JSON 内でボトルの `photoIds` と写真リストが完全に双方向一致している（未参照のゴミ写真が残っていない）ことを確認します。

---

## 6. 日常運用・保守ガイド

### 6.1 同期の基本操作
- **日常の操作**:
  - 酒を購入・開封・飲み切った際は、通常通りアプリに入力します。
  - 入力後、または Wi-Fi 接続時に「データ管理」タブの **「今すぐ同期」** ボタンをタップするだけで、最新の変更が双方向で同期されます。
- **オフラインでの利用**:
  - sake-collection は PWA のため、通信圏外（居酒屋・酒蔵・電波の届かない酒屋など）でも通常通り写真撮影・登録・記録閲覧が可能です。
  - オンラインに戻った際に「今すぐ同期」を押すことで、オフライン中の変更がクラウドに反映されます。

### 6.2 バックアップとリストア
クラウド同期に加えて、月1回程度または大量登録後にローカル JSON バックアップを書き出しておくことを推奨します。

1. 「データ管理」タブを開き、「⚙️ 同期設定・バックアップ・初期化を開く」を展開します。
2. 「JSON ファイルバックアップ」ブロックの **「バックアップを書き出す (JSON)」** をタップします。
3. `sake-collection-backup-YYYYMMDD.json` がダウンロードされます（写真の画像データもすべて含まれます）。
4. 復元時は、同ブロックの **「バックアップを読み込む (復元)」** からファイルを選択します。

### 6.3 合言葉（パスフレーズ）の変更手順
合言葉を更新する場合は、以下の順序で変更します。

1. 新しい合言葉（32文字以上のランダム文字列）を用意します。
2. **GAS 側の更新**:
   - GAS エディタ > プロジェクトの設定 > スクリプト プロパティ > `SYNC_PASSPHRASE` を新しい合言葉に編集して保存します。
3. **Cloudflare Pages 側の更新**:
   - Cloudflare Pages > `sake-collection` > Settings > Environment variables > Production および Preview の `SAKE_GAS_PASSPHRASE` を新しい合言葉に更新して保存します。
   - 最新のデプロイを再デプロイ（Retry deployment）します。
4. **端末側の反映**:
   - 次回アプリを開いた際に、Pages Functions 経由で新しい合言葉が自動同期されます。
   - ※ローカル開発環境（`localhost`）等で手動入力している端末がある場合は、「同期接続設定」の手動入力欄から合言葉を更新して「保存」します。

### 6.4 GAS コードの更新手順（clasp による再デプロイ）
`gas/Code.gs` や `gas/appsscript.json` を変更した際は、clasp（Google Apps Script CLI）を使用してプロジェクトへの反映と版更新を行います。
※ `gas/appsscript.json` の `webapp` 設定（`executeAs`: 自分 / `access`: 全員）はマニフェスト側の宣言として保持します。ただし、デプロイ側の設定（実行アカウント・アクセス権限）は別管理であり、`clasp deploy` による版更新で引き継がれる保証はありません。そのため、デプロイ後の疎通確認による検証と、不一致時の GUI での設定確認・復旧手順を運用上の歯止めとします。

#### 1. 初回セットアップ（端末ごと・初回のみ）
1. Google アカウントで clasp にログインします（未ログイン時）:
   ```bash
   npx clasp login
   ```
2. `.clasp.json.sample` をコピーして `.clasp.json` を作成します:
   ```bash
   cp .clasp.json.sample .clasp.json
   ```
3. 作成した `.clasp.json` を開き、`scriptId` に sake-collection-sync のスクリプト ID を設定します:
   ```json
   {
     "scriptId": "<YOUR_SCRIPT_ID>",
     "rootDir": "./gas"
   }
   ```
   ※ `.clasp.json` および `.clasprc.json` は `.gitignore` に登録されており、実スクリプト ID や認証トークンを Git にコミットしないよう管理対象外となっています。

#### 2. コードの反映 (push)
リポジトリの `gas/` ディレクトリの内容を Google Apps Script プロジェクトへ反映します:
```bash
npx clasp push
```
※ `.claspignore` の設定により、`Code.gs` と `appsscript.json` のみがプロジェクトへ送信されます。

#### 3. Web アプリの版更新 (deploy)
既存の Web アプリ デプロイメントを新バージョンへ更新します（Web アプリ URL を変えずに最新コードを反映）:

1. 現在のデプロイ一覧を確認し、Web アプリの Deployment ID を取得します:
   ```bash
   npx clasp deployments
   ```
   表示される一覧から、Web アプリとしてデプロイされている Deployment ID（長い英数字文字列）を確認します。
2. 既存の Deployment ID を指定して再デプロイ（新バージョンへの版更新）を実行します:
   ```bash
   npx clasp deploy -i <DEPLOYMENT_ID> -d "Update: <変更内容の説明>"
   ```
   ※ `-i <DEPLOYMENT_ID>` を指定して更新することで、**Web アプリ URL (`https://script.google.com/macros/s/.../exec`) を維持したまま最新コードが有効化されます**。Cloudflare Pages 側の環境変数（`SAKE_GAS_URL`）を再設定する必要はありません。
   ※ ブラウザの GAS エディタ（`https://script.google.com/`）の「デプロイを管理」画面から新バージョンを選択して保存する方法でも同様に更新可能です。

#### 4. 反映後の疎通確認 (fail-closed 検証)
デプロイ完了後、Web アプリのエンドポイントに対して直接リクエストを送り、適切な拒否応答が返ることを確認します。

1. **GET リクエストの拒否確認（メソッド制限）**:
   Web アプリ URL にブラウザまたは curl で直接 GET アクセスし、POST 以外が確実に拒否されることを確認します:
   ```bash
   curl -L "<GAS_WEB_APP_URL>"
   ```
   レスポンスとして、以下の JSON が返ることを確認します（`doGet` は認証を行わず、メソッド不許可の案内を返します）:
   ```json
   {"ok":false,"errorCode":"METHOD_NOT_ALLOWED","message":"sake-collection 同期 API です。POST メソッドのみ許可されています。"}
   ```

2. **POST リクエストでの合言葉認証確認（fail-closed 認証）**:
   不正な合言葉を含む POST リクエストを送り、未認証アクセスが確実に遮断されることを確認します:
   ```bash
   curl -L "<GAS_WEB_APP_URL>" \
     -H "Content-Type: application/json" \
     -d '{"action":"ping","passphrase":"invalid-passphrase"}'
   ```
   レスポンスとして、以下の認証エラー JSON が返ることを確認します:
   ```json
   {"ok":false,"errorCode":"UNAUTHORIZED","message":"認証に失敗しました（合言葉が正しくありません）"}
   ```

3. **期待した JSON が返らない場合の確認・復旧手順**:
   もしデプロイ後の疎通確認で期待した JSON（GET で `errorCode: "METHOD_NOT_ALLOWED"`）が返らず、404 エラー（HTML ページ）やアクセス拒否等になる場合は、デプロイ側の公開設定が外れている可能性があります:
   1. ブラウザで Google Apps Script エディタ（`https://script.google.com/`）を開き、対象プロジェクトを開きます。
   2. 画面右上の「デプロイ」>「デプロイを管理」を開きます。
   3. 対象の Web アプリ デプロイを選択し、編集（鉛筆アイコン）をクリックします。
   4. **次のユーザーとして実行**:「自分」
   5. **アクセスできるユーザー**:「全員」
   になっていることを確認し、必要なら設定を直して新しいバージョンで保存し直します。
   6. 保存後、再度上記ステップ 1・2 の疎通確認を実行し、期待する JSON が返ることを確認します。

### 6.5 トラブルシューティング（FAQ）

#### Q1. 「同期設定を確認中...」または設定自動取得でエラーになる
- **原因 1**: Cloudflare Access のセッションが切れている可能性があります。ブラウザを再読み込みし、認証画面が表示されたら本人のメールアドレス宛のログインコードで再認証してください。
- **原因 2**: Pages の環境変数（`SAKE_ACCESS_TEAM_DOMAIN` または `SAKE_ACCESS_AUD`）が誤っている可能性があります。手順 3.2 と 3.3 を確認してください。

#### Q2. 接続テスト (ping) で「合言葉が違います」と表示される
- **原因**: GAS のスクリプトプロパティ `SYNC_PASSPHRASE` と、Pages の環境変数 `SAKE_GAS_PASSPHRASE`（または手動入力された合言葉）が一致していません。両者の文字列が完全一致しているか再確認してください。

#### Q3. 「指定されたサーバーは sake-collection 用ではありません」と表示される
- **原因**: GAS のデプロイ URL に他アプリの URL が誤って指定されている可能性があります。GAS プロジェクト `sake-collection-sync` の正しい URL が設定されているか確認してください。

#### Q4. 「サンプルデータが読み込まれています」と表示されて同期できない
- **原因**: サンプルデータ混入防止ガードが働いています。受入確認用サンプルデータが残った状態でクラウド同期を実行することは、クラウドの個人データ汚染を防ぐため禁止されています。
- **対処法**: 「データ管理」>「全データを削除して初期化」を実行してから、クラウドからの復元または実データの登録を行ってください。

#### Q5. 写真の同期中に通信が切れた
- **動作**: sake-collection の同期クライアントはレジューム機能を備えています。アップロードは1枚ごとに即時保存され、ダウンロードは最大3枚ずつのチャンクでキャッシュされています。通信が安定した場所で再度「今すぐ同期」を押せば、中断した続きから自動的に再開されます。
