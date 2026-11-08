import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_BOTTLES, SAMPLE_PHOTOS } from '../src/data/sampleData';
import { SAKE_CATEGORIES, BOTTLE_STATUSES } from '../src/types/sake';

const __filename = fileURLToPath(import.meta.url);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function assert(condition: boolean, message: string): void {
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

  const photoIdSet = new Set<string>();
  for (const photo of SAMPLE_PHOTOS) {
    assert(UUID_REGEX.test(photo.id), `Photo ID が UUID 形式ではありません: ${photo.id}`);
    assert(UUID_REGEX.test(photo.bottleId), `Photo bottleId が UUID 形式ではありません: ${photo.bottleId}`);
    assert(['image/jpeg', 'image/webp'].includes(photo.mimeType), `不正な写真 mimeType: ${photo.mimeType}`);
    assert(typeof photo.dataUrl === 'string' && photo.dataUrl.length > 0, `Photo dataUrl が不正です: ${photo.id}`);
    assert(photo.dataUrl.startsWith('data:'), `Photo dataUrl は data: 形式である必要があります: ${photo.id}`);
    assert(ISO_DATE_REGEX.test(photo.createdAt), `Photo createdAt が ISO 8601 UTC 形式ではありません: ${photo.createdAt}`);
    assert(ISO_DATE_REGEX.test(photo.updatedAt), `Photo updatedAt が ISO 8601 UTC 形式ではありません: ${photo.updatedAt}`);
    assert(typeof photo.deleted === 'boolean', `Photo deleted が boolean ではありません: ${photo.id}`);
    assert(typeof photo.contentHash === 'string' && photo.contentHash.length > 0, `Photo contentHash が不正です: ${photo.id}`);
    photoIdSet.add(photo.id);
  }

  const bottleIdSet = new Set<string>();
  const statusCounts: Record<string, number> = {
    unopened: 0,
    opened: 0,
    finished: 0,
    disposed: 0,
  };
  const categoryCounts: Record<string, number> = {};

  for (const bottle of SAMPLE_BOTTLES) {
    assert(UUID_REGEX.test(bottle.id), `Bottle ID が UUID 形式ではありません: ${bottle.id}`);
    assert(!bottleIdSet.has(bottle.id), `Bottle ID が重複しています: ${bottle.id}`);
    bottleIdSet.add(bottle.id);

    assert(typeof bottle.name === 'string' && bottle.name.trim().length > 0, `名前が空です: ${bottle.id}`);
    assert(SAKE_CATEGORIES.includes(bottle.category), `未知の種類: ${bottle.category} (id: ${bottle.id})`);
    categoryCounts[bottle.category] = (categoryCounts[bottle.category] ?? 0) + 1;

    assert(BOTTLE_STATUSES.includes(bottle.status), `未知の状態: ${bottle.status} (id: ${bottle.id})`);
    statusCounts[bottle.status] = (statusCounts[bottle.status] ?? 0) + 1;

    assert(ISO_DATE_REGEX.test(bottle.createdAt), `createdAt が ISO 8601 UTC 形式ではありません: ${bottle.createdAt}`);
    assert(ISO_DATE_REGEX.test(bottle.updatedAt), `updatedAt が ISO 8601 UTC 形式ではありません: ${bottle.updatedAt}`);
    assert(typeof bottle.deleted === 'boolean', `deleted が boolean ではありません: ${bottle.id}`);

    // 未開封時の日付制約
    if (bottle.status === 'unopened') {
      assert(
        bottle.openedDate === null && bottle.finishedDate === null && bottle.disposedDate === null,
        `未開封ボトルの日付はすべて null である必要があります: ${bottle.id}`
      );
    }

    if (bottle.openedDate !== null) {
      assert(DATE_REGEX.test(bottle.openedDate), `openedDate が YYYY-MM-DD 形式ではありません: ${bottle.openedDate}`);
    }
    if (bottle.finishedDate !== null) {
      assert(DATE_REGEX.test(bottle.finishedDate), `finishedDate が YYYY-MM-DD 形式ではありません: ${bottle.finishedDate}`);
    }
    if (bottle.disposedDate !== null) {
      assert(DATE_REGEX.test(bottle.disposedDate), `disposedDate が YYYY-MM-DD 形式ではありません: ${bottle.disposedDate}`);
    }

    // 購入情報と相場目安の完全分離検証
    assert(bottle.purchaseInfo !== undefined, `purchaseInfo が未定義です: ${bottle.id}`);
    if (bottle.purchaseInfo.purchasePriceYen !== null) {
      assert(
        typeof bottle.purchaseInfo.purchasePriceYen === 'number' && bottle.purchaseInfo.purchasePriceYen >= 0,
        `購入価格は正の数値または null である必要があります: ${bottle.id}`
      );
    }
    if (bottle.referencePrice !== null) {
      assert(
        typeof bottle.referencePrice.estimatedPriceYen === 'number' && bottle.referencePrice.estimatedPriceYen >= 0,
        `相場目安推定値は正の数値である必要があります: ${bottle.id}`
      );
      if (bottle.referencePrice.fetchedDate !== null) {
        assert(
          DATE_REGEX.test(bottle.referencePrice.fetchedDate),
          `相場目安取得日は YYYY-MM-DD 形式である必要があります: ${bottle.referencePrice.fetchedDate}`
        );
      }
    }

    // 写真IDの紐付け整合性
    for (const photoId of bottle.photoIds) {
      assert(photoIdSet.has(photoId), `Bottle ${bottle.id} の photoId ${photoId} が SAMPLE_PHOTOS に存在しません`);
    }
    if (bottle.primaryPhotoId !== null) {
      assert(
        bottle.photoIds.includes(bottle.primaryPhotoId),
        `primaryPhotoId ${bottle.primaryPhotoId} は photoIds に含まれる必要があります (bottle: ${bottle.id})`
      );
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

  console.log(`✓ サンプルデータ検証完了: ボトル ${SAMPLE_BOTTLES.length}件、写真 ${SAMPLE_PHOTOS.length}件`);
}

/**
 * 2. 禁止記述の機械検査
 */
function verifyNoForbiddenComments(): void {
  console.log('--- 2. 禁止コメント検査 ---');
  const targetDirs = ['src', 'scripts', 'tests'];
  const patterns = [
    { name: '@' + 'ts' + '-ignore', regex: new RegExp('@' + 'ts' + '-ignore') },
    { name: '@' + 'ts' + '-expect-error', regex: new RegExp('@' + 'ts' + '-expect-error') },
    { name: '@' + 'ts' + '-nocheck', regex: new RegExp('@' + 'ts' + '-nocheck') },
    { name: 'eslint' + '-disable', regex: new RegExp('eslint' + '-disable') },
  ];

  const currentScriptPath = path.resolve(__filename);
  const foundErrors: string[] = [];

  function scanDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        if (path.resolve(fullPath) === currentScriptPath) {
          continue;
        }
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
    }
  }

  for (const dir of targetDirs) {
    scanDir(path.resolve(process.cwd(), dir));
  }

  if (foundErrors.length > 0) {
    console.error('禁止記述が検出されました:');
    foundErrors.forEach((err) => console.error(`  - ${err}`));
    throw new Error(`[verify:data] 禁止記述が ${foundErrors.length} 箇所で検出されました。抑制コメントは禁止です。`);
  }

  console.log('✓ 禁止コメント検査完了: 禁止記述なし');
}

/**
 * 3. 実写真ファイル・実データ混入防止検査
 */
function verifyNoRealPhotosOrData(): void {
  console.log('--- 3. 実写真・実データ混入防止検査 ---');
  const projectRoot = process.cwd();
  const photoExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.bmp', '.gif'];
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', '.gemini']);

  const foundPhotoFiles: string[] = [];
  const foundDataFiles: string[] = [];

  function scan(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          scan(path.join(currentDir, entry.name));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (photoExtensions.includes(ext)) {
          foundPhotoFiles.push(path.relative(projectRoot, path.join(currentDir, entry.name)));
        }
        if (entry.name.endsWith('.local.json')) {
          foundDataFiles.push(path.relative(projectRoot, path.join(currentDir, entry.name)));
        }
      }
    }
  }

  scan(projectRoot);

  if (foundPhotoFiles.length > 0) {
    console.error('実写真ファイルが検出されました（リポジトリへのコミットは禁止です）:');
    foundPhotoFiles.forEach((file) => console.error(`  - ${file}`));
    throw new Error('[verify:data] 実写真ファイルがリポジトリ内に存在します');
  }

  if (foundDataFiles.length > 0) {
    console.error('ローカル実データファイルが検出されました（コミット禁止）:');
    foundDataFiles.forEach((file) => console.error(`  - ${file}`));
    throw new Error('[verify:data] ローカル実データファイルがリポジトリ内に存在します');
  }

  console.log('✓ 実写真・実データ混入防止検査完了: 混入ファイルなし');
}

function main(): void {
  try {
    verifySampleData();
    verifyNoForbiddenComments();
    verifyNoRealPhotosOrData();
    console.log('\n[verify:data] 全ての検証に成功しました (exit 0)');
    process.exit(0);
  } catch (error) {
    console.error('\n' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

main();
