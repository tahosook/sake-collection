/**
 * Cloudflare Pages Function: GET /api/sync-config
 *
 * 設計: docs/step3-4-design.md §4(2)
 *
 * 役割:
 * - 本人（Cloudflare Access 認証済み）にのみ同期設定（GAS URL・合言葉）を安全に配布
 * - fail-closed: Access ヘッダー（Cf-Access-Jwt-Assertion または Cf-Access-Authenticated-User-Email）がなければ 403 Forbidden
 * - Cache-Control: no-store によりブラウザおよび中間プロキシへのキャッシュを完全抑止
 * - 公開リポジトリやビルド成果物 (dist/) に平文設定を埋め込まず、Pages Secrets から動的取得
 */

interface Env {
  SAKE_GAS_URL?: string;
  SAKE_GAS_PASSPHRASE?: string;
}

interface EventContext<E, P extends string, D> {
  request: Request;
  functionPath: string;
  waitUntil: (promise: Promise<unknown>) => void;
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  env: E;
  params: Record<P, string | string[]>;
  data: D;
}

export type PagesFunction<
  E = Env,
  P extends string = string,
  D extends Record<string, unknown> = Record<string, unknown>
> = (context: EventContext<E, P, D>) => Response | Promise<Response>;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Cloudflare Access 認証ヘッダーの検証 (fail-closed)
  const jwtAssertion = request.headers.get('Cf-Access-Jwt-Assertion');
  const userEmail = request.headers.get('Cf-Access-Authenticated-User-Email');

  if (!jwtAssertion && !userEmail) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Forbidden: Cloudflare Access authentication required',
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  // 2. Pages Secrets からの同期設定取得
  const gasUrl = env.SAKE_GAS_URL ? env.SAKE_GAS_URL.trim() : '';
  const passphrase = env.SAKE_GAS_PASSPHRASE ? env.SAKE_GAS_PASSPHRASE.trim() : '';

  if (!gasUrl || !passphrase) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Sync configuration is not configured in Pages secrets (SAKE_GAS_URL or SAKE_GAS_PASSPHRASE missing)',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  // 3. 正常レスポンス (no-store 強制)
  return new Response(
    JSON.stringify({
      ok: true,
      gasUrl,
      passphrase,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    }
  );
};
