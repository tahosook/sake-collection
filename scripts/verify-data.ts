import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../src/data/sampleData';
import { SAKE_CATEGORIES, BOTTLE_STATUSES, BottleRecord } from '../src/types/sake';
import { CATEGORY_ATTRIBUTE_LABELS } from '../src/domain/categories';
import { isValidCalendarDate } from '../src/domain/validation';

const __filename = fileURLToPath(import.meta.url);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const HASH_HEX_REGEX = /^[0-9a-f]{64}$/i;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[verify:data] 検証エラー: ${message}`);
  }
}

/**
 * 1. サンプルデータ・スキーマ整合性検証
 */
function verifySampleData(): void {
  console.log('--- 1. サンプルデータ整合性検証 ---');
  assert(Array.isArray(SAMPLE_BOTTLES) && SAMPLE_BOTTLES.length > 0, 'SAMPLE_BOTTLES が空です');
  assert(Array.isArray(SAMPLE_PHOTOS) && SAMPLE_PHOTOS.length > 0, 'SAMPLE_PHOTOS が空です');

  const bottleMap = new Map<string, BottleRecord>();
  const statusCounts: Record<string, number> = {
    unopened: 0,
    opened: 0,
    finished: 0,
    disposed: 0,
  };
  const categoryCounts: Record<string, number> = {};

  for (const bottle of SAMPLE_BOTTLES) {
    assert(UUID_REGEX.test(bottle.id), `Bottle ID が UUID 形式ではありません: ${bottle.id}`);
    assert(!bottleMap.has(bottle.id), `Bottle ID が重複しています: ${bottle.id}`);
    bottleMap.set(bottle.id, bottle);

    assert(typeof bottle.name === 'string' && bottle.name.trim().length > 0, `名前が空です: ${bottle.id}`);
    assert(SAKE_CATEGORIES.includes(bottle.category), `未知の種類: ${bottle.category} (id: ${bottle.id})`);
    categoryCounts[bottle.category] = (categoryCounts[bottle.category] ?? 0) + 1;

    assert(BOTTLE_STATUSES.includes(bottle.status), `未知の状態: ${bottle.status} (id: ${bottle.id})`);
    statusCounts[bottle.status] = (statusCounts[bottle.status] ?? 0) + 1;

    assert(ISO_DATE_REGEX.test(bottle.createdAt), `createdAt が ISO 8601 UTC 形式ではありません: ${bottle.createdAt}`);
    assert(ISO_DATE_REGEX.test(bottle.updatedAt), `updatedAt が ISO 8601 UTC 形式ではありません: ${bottle.updatedAt}`);
    assert(typeof bottle.deleted === 'boolean', `deleted が boolean ではありません: ${bottle.id}`);

    // 状態ごとの日付制約検証
    if (bottle.status === 'unopened') {
      assert(
        bottle.openedDate === null && bottle.finishedDate === null && bottle.disposedDate === null,
        `未開封ボトルの日付はすべて null である必要があります: ${bottle.id}`
      );
    } else if (bottle.status === 'opened') {
      assert(
        bottle.finishedDate === null && bottle.disposedDate === null,
        `開封済みボトルの飲み切り日・手放した日は null である必要があります: ${bottle.id}`
      );
    } else if (bottle.status === 'finished') {
      assert(
        bottle.disposedDate === null,
        `飲み切りボトルの手放した日は null である必要があります: ${bottle.id}`
      );
    } else if (bottle.status === 'disposed') {
      assert(
        bottle.finishedDate === null,
        `手放したボトルの飲み切り日は null である必要があります: ${bottle.id}`
      );
    }

    if (bottle.openedDate !== null) {
      assert(isValidCalendarDate(bottle.openedDate), `openedDate が実在する有効な日付ではありません: ${bottle.openedDate}`);
    }
    if (bottle.finishedDate !== null) {
      assert(isValidCalendarDate(bottle.finishedDate), `finishedDate が実在する有効な日付ではありません: ${bottle.finishedDate}`);
    }
    if (bottle.disposedDate !== null) {
      assert(isValidCalendarDate(bottle.disposedDate), `disposedDate が実在する有効な日付ではありません: ${bottle.disposedDate}`);
    }

    // 種類別追加属性のキー検査（許可された属性キーのみが存在するか）
    const allowedAttrs = CATEGORY_ATTRIBUTE_LABELS[bottle.category];
    const actualAttrKeys = Object.keys(bottle.categoryAttributes);
    for (const key of actualAttrKeys) {
      assert(
        key in allowedAttrs,
        `種類 '${bottle.category}' に許可されていない属性キー '${key}' が含まれています (bottle: ${bottle.id})`
      );
    }

    // 感想メモ・また買いたい印・編集保護メタデータ
    assert(typeof bottle.tastingNote === 'string', `tastingNote は文字列である必要があります: ${bottle.id}`);
    assert(typeof bottle.wantToBuyAgain === 'boolean', `wantToBuyAgain は真偽値である必要があります: ${bottle.id}`);
    assert(Array.isArray(bottle.userEditedFields), `userEditedFields は配列である必要があります: ${bottle.id}`);

    // 解説・出典
    if (bottle.description !== null) {
      assert(
        typeof bottle.description.summary === 'string' &&
        typeof bottle.description.tasteProfile === 'string' &&
        typeof bottle.description.background === 'string' &&
        typeof bottle.description.servingSuggestion === 'string',
        `解説の4部構成フィールドが不正です: ${bottle.id}`
      );
    }
    assert(Array.isArray(bottle.sources), `sources は配列である必要があります: ${bottle.id}`);
    for (const source of bottle.sources) {
      assert(typeof source.url === 'string' && source.url.startsWith('http'), `出典URLが不正です: ${bottle.id}`);
    }

    // 購入情報と相場目安の完全分離検証
    assert(bottle.purchaseInfo !== undefined, `purchaseInfo が未定義です: ${bottle.id}`);
    if (bottle.purchaseInfo.purchasePriceYen !== null) {
      assert(
        typeof bottle.purchaseInfo.purchasePriceYen === 'number' && bottle.purchaseInfo.purchasePriceYen >= 0,
        `購入価格は正の数値または null である必要があります: ${bottle.id}`
      );
    }
    if (bottle.purchaseInfo.purchaseDate !== null) {
      assert(isValidCalendarDate(bottle.purchaseInfo.purchaseDate), `購入日が実在する有効な日付ではありません: ${bottle.purchaseInfo.purchaseDate}`);
    }
    if (bottle.referencePrice !== null) {
      if (bottle.referencePrice.estimatedPriceYen !== null) {
        assert(
          typeof bottle.referencePrice.estimatedPriceYen === 'number' && bottle.referencePrice.estimatedPriceYen >= 0,
          `相場目安推定値は正の数値または null である必要があります: ${bottle.id}`
        );
      }
      if (bottle.referencePrice.fetchedDate !== null) {
        assert(
          isValidCalendarDate(bottle.referencePrice.fetchedDate),
          `相場目安取得日が実在する有効な日付ではありません: ${bottle.referencePrice.fetchedDate}`
        );
      }
    }
  }

  // 全4状態の存在確認
  for (const status of BOTTLE_STATUSES) {
    assert((statusCounts[status] ?? 0) > 0, `サンプルデータに状態 '${status}' のボトルが存在しません`);
  }

  // 固定10種類すべてが存在することを確認
  for (const cat of SAKE_CATEGORIES) {
    assert((categoryCounts[cat] ?? 0) > 0, `サンプルデータに種類 '${cat}' のボトルが存在しません`);
  }

  // 写真データの検証および双方向参照整合性検証
  const photoIdSet = new Set<string>();
  for (const photo of SAMPLE_PHOTOS) {
    assert(UUID_REGEX.test(photo.id), `Photo ID が UUID 形式ではありません: ${photo.id}`);
    assert(!photoIdSet.has(photo.id), `Photo ID が重複しています: ${photo.id}`);
    photoIdSet.add(photo.id);

    assert(UUID_REGEX.test(photo.bottleId), `Photo bottleId が UUID 形式ではありません: ${photo.bottleId}`);
    assert(['image/jpeg', 'image/webp'].includes(photo.mimeType), `不正な写真 mimeType: ${photo.mimeType}`);
    assert(typeof photo.dataUrl === 'string' && photo.dataUrl.length > 0, `Photo dataUrl が不正です: ${photo.id}`);

    // mimeType と dataUrl プレフィックスの整合性
    const expectedPrefix = `data:${photo.mimeType};base64,`;
    assert(
      photo.dataUrl.startsWith(expectedPrefix),
      `Photo dataUrl は '${expectedPrefix}' で始まる必要があります: ${photo.id}`
    );

    assert(ISO_DATE_REGEX.test(photo.createdAt), `Photo createdAt が ISO 8601 UTC 形式ではありません: ${photo.createdAt}`);
    assert(ISO_DATE_REGEX.test(photo.updatedAt), `Photo updatedAt が ISO 8601 UTC 形式ではありません: ${photo.updatedAt}`);
    assert(typeof photo.deleted === 'boolean', `Photo deleted が boolean ではありません: ${photo.id}`);
    assert(
      HASH_HEX_REGEX.test(photo.contentHash),
      `Photo contentHash は64桁の16進文字列(SHA-256 hex)である必要があります: ${photo.id}`
    );

    // 実際の JPEG バイト列から計算した SHA-256 ハッシュおよびバイト長との整合性検証
    const base64Data = photo.dataUrl.slice(expectedPrefix.length);
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const calculatedHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
    assert(
      calculatedHash.toLowerCase() === photo.contentHash.toLowerCase(),
      `Photo contentHash が JPEG バイト列の実際の SHA-256 値と一致しません (期待値: ${calculatedHash}, 実際値: ${photo.contentHash}): ${photo.id}`
    );
    assert(
      photo.byteSize === imageBuffer.length,
      `Photo byteSize (${photo.byteSize}) が実際の JPEG バイト長 (${imageBuffer.length}) と一致しません: ${photo.id}`
    );

    // 双方向参照整合性：photo.bottleId のボトルが存在し、そのボトルの photoIds に photo.id が含まれていること
    const parentBottle = bottleMap.get(photo.bottleId);
    assert(parentBottle !== undefined, `Photo ${photo.id} の親ボトル ${photo.bottleId} が存在しません`);
    assert(
      parentBottle.photoIds.includes(photo.id),
      `Photo ${photo.id} の親ボトル ${photo.bottleId} の photoIds にこの写真IDが含まれていません`
    );
  }

  // ボトル側から写真への参照整合性 (photo.bottleId との一致確認)
  const photoMap = new Map(SAMPLE_PHOTOS.map((p) => [p.id, p]));
  for (const bottle of SAMPLE_BOTTLES) {
    for (const photoId of bottle.photoIds) {
      const photo = photoMap.get(photoId);
      assert(photo !== undefined, `Bottle ${bottle.id} の photoId ${photoId} が SAMPLE_PHOTOS に存在しません`);
      assert(
        photo.bottleId === bottle.id,
        `Bottle ${bottle.id} の photoIds に含まれる写真 ${photoId} の bottleId (${photo.bottleId}) が一致しません`
      );
    }
    if (bottle.primaryPhotoId !== null) {
      assert(
        bottle.photoIds.includes(bottle.primaryPhotoId),
        `primaryPhotoId ${bottle.primaryPhotoId} は photoIds に含まれる必要があります (bottle: ${bottle.id})`
      );
    }
  }

  console.log(`✓ サンプルデータ検証完了: ボトル ${SAMPLE_BOTTLES.length}件、写真 ${SAMPLE_PHOTOS.length}件 (双方向参照整合性確認済)`);
}

/**
 * 2. 禁止記述の機械検査
 */
function verifyNoForbiddenComments(): void {
  console.log('--- 2. 禁止コメント検査 ---');
  const targetDirs = ['src', 'scripts', 'tests'];
  const targetFiles = [
    'eslint.config.js',
    'vite.config.ts',
    'tailwind.config.js',
    'postcss.config.js',
  ];
  const patterns = [
    { name: '@' + 'ts' + '-ignore', regex: new RegExp('@' + 'ts' + '-ignore') },
    { name: '@' + 'ts' + '-expect-error', regex: new RegExp('@' + 'ts' + '-expect-error') },
    { name: '@' + 'ts' + '-nocheck', regex: new RegExp('@' + 'ts' + '-nocheck') },
    { name: 'eslint' + '-disable', regex: new RegExp('eslint' + '-disable') },
  ];

  const currentScriptPath = path.resolve(__filename);
  const projectRoot = process.cwd();
  const foundErrors: string[] = [];

  function checkFile(fullPath: string): void {
    if (path.resolve(fullPath) === currentScriptPath) {
      return;
    }
    if (!fs.existsSync(fullPath)) return;
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
          foundErrors.push(`${fullPath}:${index + 1} に禁止記述 '${pattern.name}' が含まれています: ${line.trim()}`);
        }
      }
    });
  }

  function scanDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        checkFile(fullPath);
      }
    }
  }

  for (const dir of targetDirs) {
    scanDir(path.resolve(projectRoot, dir));
  }
  for (const file of targetFiles) {
    checkFile(path.resolve(projectRoot, file));
  }

  if (foundErrors.length > 0) {
    console.error('禁止記述が検出されました:');
    foundErrors.forEach((err) => console.error(`  - ${err}`));
    throw new Error(`[verify:data] 禁止記述が ${foundErrors.length} 箇所で検出されました。抑制コメントは禁止です。`);
  }

  console.log('✓ 禁止コメント検査完了: 禁止記述なし');
}

/**
 * 3. 許可外JSON・画像ファイル混入防止検査（AGENTS.md §2 準拠）
 */
function verifyNoRealPhotosOrData(): void {
  console.log('--- 3. 許可外JSON・画像ファイル混入防止検査 ---');
  const projectRoot = process.cwd();

  // 禁止する画像拡張子
  const photoExtensions = [
    '.jpg', '.jpeg', '.png', '.webp', '.heic',
    '.bmp', '.gif', '.svg', '.avif', '.ico', '.tiff',
  ];

  // リポジトリ内で許可された JSON ファイルの相対パス一覧（ホワイトリスト方式）
  const allowedJsonFiles = new Set([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    path.join('gas', 'appsscript.json'),
    'gas/appsscript.json',
    '.clasp.json',
  ]);

  // スキャン除外ディレクトリ
  const ignoredDirs = new Set(['.git', 'node_modules', '.gemini']);

  const foundPhotoFiles: string[] = [];
  const foundDisallowedJsonFiles: string[] = [];

  function scan(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(projectRoot, fullPath);

      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          scan(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // 画像ファイルの検出
        if (photoExtensions.includes(ext)) {
          foundPhotoFiles.push(relativePath);
        }
        // JSON ファイルのホワイトリスト検査
        if (ext === '.json') {
          if (!allowedJsonFiles.has(relativePath)) {
            foundDisallowedJsonFiles.push(relativePath);
          }
        }
      }
    }
  }

  scan(projectRoot);

  if (foundPhotoFiles.length > 0) {
    console.error('画像ファイルが検出されました（リポジトリ内への画像ファイル配置は禁止です）:');
    foundPhotoFiles.forEach((file) => console.error(`  - ${file}`));
    throw new Error('[verify:data] 画像ファイルがリポジトリ内に存在します');
  }

  if (foundDisallowedJsonFiles.length > 0) {
    console.error('許可外の JSON ファイルが検出されました（実データや余計な JSON のコミットは禁止です）:');
    foundDisallowedJsonFiles.forEach((file) => console.error(`  - ${file}`));
    throw new Error('[verify:data] 許可外の JSON ファイルがリポジトリ内に存在します');
  }

  console.log('✓ 許可外JSON・画像ファイル混入防止検査完了: 混入ファイルなし (ホワイトリスト準拠)');
}

/**
 * 4. 外部 LLM API 直呼び出し禁止検査（AGENTS.md §1 準拠）
 * アプリから外部 LLM API を直接呼ばず、プロンプトコピー＆JSON取り込み方式を徹底する
 * ファイル全体および package.json の依存関係を検査
 */
function verifyNoDirectLlmApi(): void {
  console.log('--- 4. 外部 LLM API 直呼び出し禁止検査 ---');
  const projectRoot = process.cwd();
  const srcDir = path.resolve(projectRoot, 'src');

  // 禁止する外部 LLM API エンドポイントおよび SDK パッケージ名
  const forbiddenPatterns = [
    { name: 'Gemini API Endpoint', regex: new RegExp(['generativelanguage', 'googleapis', 'com'].join('.')) },
    { name: 'OpenAI API Endpoint', regex: new RegExp(['api', 'openai', 'com'].join('.')) },
    { name: 'Anthropic API Endpoint', regex: new RegExp(['api', 'anthropic', 'com'].join('.')) },
    { name: 'Google Generative AI SDK', regex: new RegExp('@' + 'google/generative-ai') },
    { name: 'Google GenAI SDK', regex: new RegExp('@' + 'google/genai') },
    { name: 'Anthropic SDK', regex: new RegExp('@' + 'anthropic-ai') },
  ];

  const forbiddenPackages = [
    '@' + 'google/generative-ai',
    '@' + 'google/genai',
    'openai',
    '@' + 'anthropic-ai/sdk',
    '@' + 'anthropic-ai',
  ];

  const foundErrors: string[] = [];

  // A. src/ 配下のファイル全体に対する正規表現検査
  function scan(currentDir: string): void {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of forbiddenPatterns) {
          if (pattern.regex.test(content)) {
            // 行番号も特定してわかりやすく報告
            const lines = content.split('\n');
            const matchingLineIdx = lines.findIndex((l) => pattern.regex.test(l));
            const lineInfo = matchingLineIdx !== -1 ? `:${matchingLineIdx + 1}` : '';
            foundErrors.push(`${fullPath}${lineInfo} に外部 LLM API の直接参照 '${pattern.name}' が含まれています`);
          }
        }
      }
    }
  }

  scan(srcDir);

  // B. package.json の依存関係検査
  const packageJsonPath = path.resolve(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
      const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
      for (const section of depSections) {
        if (typeof pkg[section] === 'object' && pkg[section] !== null) {
          const deps = Object.keys(pkg[section] as Record<string, unknown>);
          for (const dep of deps) {
            for (const forbiddenPkg of forbiddenPackages) {
              if (dep === forbiddenPkg || dep.startsWith(forbiddenPkg + '/')) {
                foundErrors.push(`package.json の ${section} に禁止対象の LLM SDK '${dep}' が含まれています`);
              }
            }
          }
        }
      }
    } catch (err) {
      foundErrors.push(`package.json の読み込み・構文解析に失敗しました: ${String(err)}`);
    }
  }

  if (foundErrors.length > 0) {
    console.error('外部 LLM API の直接呼び出し・SDK 参照が検出されました（アプリからの直接呼び出しは禁止です）:');
    foundErrors.forEach((err) => console.error(`  - ${err}`));
    throw new Error(`[verify:data] 外部 LLM API 直呼び出しが ${foundErrors.length} 箇所で検出されました`);
  }

  console.log('✓ 外部 LLM API 直呼び出し禁止検査完了: 直接呼び出し・SDK 参照なし (ファイル全体および依存関係)');
}

/**
 * 5. 秘密情報（合言葉・実デプロイURL）および他アプリ（Smart Closet）識別子の混入防止検査
 *
 * 設計: docs/step3-4-design.md §2(5), PR #12
 * レビュー指摘対応 (PR #12):
 * - スキャン範囲をリポジトリルートからの再帰走査に拡張 (生成物・依存物のみ除外)
 * - docs／tests／scripts／.github／ルート設定ファイル等を全域走査
 * - 実 GAS デプロイ URL (script.google.com/macros/s/) の全域禁止
 * - クライアント埋め込み環境変数 (VITE_GAS_*) の全域禁止
 * - Smart Closet リソース識別子 (smart-closet / smart_closet / smartcloset / SMART_CLOSET) の全域禁止
 * - コード・テスト・ワークフロー・設定ファイル等への Smart Closet 言及の混入禁止
 */
function verifyNoSecretsOrCrossAppIdentifiers(): void {
  console.log('--- 5. 秘密情報・他アプリ識別子混入防止検査 ---');
  const projectRoot = process.cwd();
  const currentScriptPath = path.resolve(__filename);

  // 明示的な除外ディレクトリ
  const ignoredDirs = new Set(['node_modules', '.git', 'dist', '.gemini']);

  // 検出パターン
  const forbiddenPatterns: Array<{
    name: string;
    regex: RegExp;
    isForbiddenForFile: (relativePath: string) => boolean;
  }> = [
    {
      name: '実 GAS デプロイ URL (script.google.com/macros/s/.../exec)',
      // 実際のデプロイ ID が続く実 URL を検出（docs を含むリポジトリ全域で禁止）
      regex: new RegExp(['https?:\\/\\/script', 'google', 'com\\/macros\\/s\\/[A-Za-z0-9_-]{10,}'].join('.')),
      isForbiddenForFile: () => true,
    },
    {
      name: 'クライアント埋め込み GAS 環境変数 (VITE_GAS_*)',
      // docs (設計仕様文) 以外（コード・設定・テスト・ワークフロー等）で禁止
      regex: /VITE_GAS_/i,
      isForbiddenForFile: (relPath: string) => {
        const isDoc =
          relPath === 'AGENTS.md' ||
          relPath === 'README.md' ||
          relPath.startsWith('docs' + path.sep) ||
          relPath.startsWith('docs/');
        return !isDoc;
      },
    },
    {
      name: 'Smart Closet リソース識別子 (smart-closet / smart_closet / smartcloset / SMART_CLOSET)',
      // docs を含むリポジトリ全域で禁止
      regex: new RegExp(['smart', 'closet'].join('[-_]?'), 'i'),
      isForbiddenForFile: () => true,
    },
    {
      name: 'Smart Closet 言及 (コード・設定・テスト・CIへの混入)',
      // ドキュメント (docs/, AGENTS.md, README.md) 以外（ソース・設定・テスト・ワークフロー等）で禁止
      regex: new RegExp(['smart', 'closet'].join('\\s+'), 'i'),
      isForbiddenForFile: (relPath: string) => {
        const isDoc =
          relPath === 'AGENTS.md' ||
          relPath === 'README.md' ||
          relPath.startsWith('docs' + path.sep) ||
          relPath.startsWith('docs/');
        return !isDoc;
      },
    },
  ];

  const foundErrors: string[] = [];

  function checkContent(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const relativePath = path.relative(projectRoot, filePath);

    // バイナリ・画像等は除外 (拡張子チェック)
    const ext = path.extname(filePath).toLowerCase();
    const binaryExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz'];
    if (binaryExtensions.includes(ext)) {
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      // 読み込み不可ファイルはスキップ
      return;
    }

    const lines = content.split('\n');
    lines.forEach((line, index) => {
      for (const pattern of forbiddenPatterns) {
        if (pattern.isForbiddenForFile(relativePath) && pattern.regex.test(line)) {
          foundErrors.push(
            `${relativePath}:${index + 1} に禁止パターン '${pattern.name}' が含まれています: ${line.trim()}`
          );
        }
      }
    });
  }

  function scan(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          scan(fullPath);
        }
      } else if (entry.isFile()) {
        if (path.resolve(fullPath) === currentScriptPath) {
          continue; // 自身は除外
        }
        checkContent(fullPath);
      }
    }
  }

  scan(projectRoot);

  if (foundErrors.length > 0) {
    console.error('秘密情報または他アプリ識別子の混入が検出されました:');
    foundErrors.forEach((err) => console.error(`  - ${err}`));
    throw new Error(
      `[verify:data] 秘密情報・他アプリ識別子が ${foundErrors.length} 箇所で検出されました`
    );
  }

  console.log('✓ 秘密情報・他アプリ識別子混入防止検査完了: 混入なし (完全分離確認済)');
}

function main(): void {
  try {
    verifySampleData();
    verifyNoForbiddenComments();
    verifyNoRealPhotosOrData();
    verifyNoDirectLlmApi();
    verifyNoSecretsOrCrossAppIdentifiers();
    console.log('\n[verify:data] 全ての検証に成功しました (exit 0)');
    process.exit(0);
  } catch (error) {
    console.error('\n' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

main();
