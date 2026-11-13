/// <reference types="vitest" />
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * ビルド成果物 (dist/) からアプリシェル対象の一覧と SHA-256 ハッシュを算出し、
 * dist/sw.js の CACHE_VERSION と PRECACHE_URLS へ注入する Vite プラグイン
 */
function sakePwaPrecachePlugin(): Plugin {
  return {
    name: 'sake-pwa-precache',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(process.cwd(), 'dist');
      const swPath = path.join(distDir, 'sw.js');
      if (!fs.existsSync(swPath)) {
        throw new Error('[sake-pwa-precache] dist/sw.js が見つかりません');
      }

      const precacheUrls: string[] = [];
      const filesToHash: string[] = [];

      if (fs.existsSync(path.join(distDir, 'index.html'))) {
        precacheUrls.push('/');
        filesToHash.push('index.html');
      }

      if (fs.existsSync(path.join(distDir, 'manifest.webmanifest'))) {
        precacheUrls.push('/manifest.webmanifest');
        filesToHash.push('manifest.webmanifest');
      }

      const iconsDir = path.join(distDir, 'icons');
      if (fs.existsSync(iconsDir)) {
        const iconFiles = fs
          .readdirSync(iconsDir)
          .filter((name) => /\.(png|svg)$/i.test(name))
          .sort();
        for (const file of iconFiles) {
          precacheUrls.push(`/icons/${file}`);
          filesToHash.push(path.join('icons', file));
        }
      }

      const assetsDir = path.join(distDir, 'assets');
      if (fs.existsSync(assetsDir)) {
        const assetFiles = fs
          .readdirSync(assetsDir)
          .filter((name) => /\.(js|css)$/i.test(name))
          .sort();
        for (const file of assetFiles) {
          precacheUrls.push(`/assets/${file}`);
          filesToHash.push(path.join('assets', file));
        }
      }

      const hash = crypto.createHash('sha256');
      for (const relPath of filesToHash) {
        hash.update(relPath.replace(/\\/g, '/'));
        hash.update(fs.readFileSync(path.join(distDir, relPath)));
      }
      const cacheVersion = `sake-shell-${hash.digest('hex').slice(0, 12)}`;

      const swSource = fs.readFileSync(swPath, 'utf8');
      const versionMarker = "const CACHE_VERSION = '__SAKE_CACHE_VERSION__';";
      const urlsMarker = 'const PRECACHE_URLS = [];';

      if (!swSource.includes(versionMarker) || !swSource.includes(urlsMarker)) {
        throw new Error('[sake-pwa-precache] dist/sw.js に注入マーカーが見つかりません');
      }

      const injectedSw = swSource
        .replace(versionMarker, `const CACHE_VERSION = '${cacheVersion}';`)
        .replace(urlsMarker, `const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};`);

      fs.writeFileSync(swPath, injectedSw, 'utf8');
    },
  };
}

export default defineConfig({
  plugins: [react(), sakePwaPrecachePlugin()],
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  },
});
