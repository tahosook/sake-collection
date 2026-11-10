/**
 * Cloudflare Pages Function: GET /api/sync-config
 *
 * 設計: docs/step3-4-design.md §4(2)
 * レビュー指摘対応 (PR #12):
 * - 単なるヘッダー存在確認ではなく、Cloudflare Access の JWT (Cf-Access-Jwt-Assertion) の署名・issuer・audience・有効期限を完全検証
 * - fail-closed: チームドメイン・audience・GAS 設定が未設定または検証失敗時は設定を一切返さない
 * - Cache-Control: no-store によりブラウザおよび中間プロキシへのキャッシュを完全抑止
 */

interface Env {
  SAKE_GAS_URL?: string;
  SAKE_GAS_PASSPHRASE?: string;
  SAKE_ACCESS_TEAM_DOMAIN?: string;
  SAKE_ACCESS_AUD?: string;
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

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
}

interface JwksKey extends JsonWebKey {
  kid?: string;
}

interface JwksResponse {
  keys: JwksKey[];
}

/** メモリ内 JWKS キャッシュ (同一コンテナでの再利用) */
let cachedJwks: { keys: JwksKey[]; fetchedAt: number; certsUrl: string } | null = null;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1時間

/**
 * Uint8Array から独立した ArrayBuffer (BufferSource 互換) を生成
 */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

/**
 * Base64URL 文字列を Uint8Array にデコード
 */
function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Base64URL 文字列を JSON デコード
 */
function base64UrlDecodeJson<T>(str: string): T {
  const bytes = base64UrlDecode(str);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

/**
 * チームドメイン文字列を正規化し、JWKS URL と expectedIssuer を生成
 */
function normalizeTeamDomain(domainInput: string): { certsUrl: string; expectedIssuer: string } {
  let host = domainInput.trim();
  if (host.startsWith('https://')) {
    host = host.slice('https://'.length);
  }
  if (host.startsWith('http://')) {
    host = host.slice('http://'.length);
  }
  if (host.endsWith('/')) {
    host = host.slice(0, -1);
  }
  if (!host.includes('.')) {
    host = `${host}.cloudflareaccess.com`;
  }
  return {
    certsUrl: `https://${host}/cdn-cgi/access/certs`,
    expectedIssuer: `https://${host}`,
  };
}

/**
 * Cloudflare Access の公開鍵一覧 (JWKS) を取得
 */
async function getAccessJwks(certsUrl: string, forceRefresh = false): Promise<JwksKey[]> {
  const now = Date.now();
  if (!forceRefresh && cachedJwks && cachedJwks.certsUrl === certsUrl && now - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks.keys;
  }

  const res = await fetch(certsUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS from ${certsUrl} (status: ${res.status})`);
  }

  const data = (await res.json()) as JwksResponse;
  if (!data || !Array.isArray(data.keys)) {
    throw new Error(`Invalid JWKS response structure from ${certsUrl}`);
  }

  cachedJwks = {
    keys: data.keys,
    fetchedAt: now,
    certsUrl: certsUrl,
  };

  return data.keys;
}

/**
 * Cloudflare Access JWT (Cf-Access-Jwt-Assertion) の完全検証
 */
async function verifyCloudflareAccessJwt(
  jwt: string,
  teamDomain: string,
  expectedAud: string
): Promise<{ ok: boolean; reason?: string }> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'JWT does not have 3 parts' };
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // A. ヘッダーのパースと検証
  let header: JwtHeader;
  try {
    header = base64UrlDecodeJson<JwtHeader>(headerB64);
  } catch {
    return { ok: false, reason: 'Invalid JWT header JSON' };
  }

  if (header.alg !== 'RS256') {
    return { ok: false, reason: `Unsupported JWT alg: ${header.alg} (expected RS256)` };
  }
  if (!header.kid) {
    return { ok: false, reason: 'Missing JWT header kid' };
  }

  // B. ペイロードのパースと検証 (有効期限・発行者・Audience)
  let payload: JwtPayload;
  try {
    payload = base64UrlDecodeJson<JwtPayload>(payloadB64);
  } catch {
    return { ok: false, reason: 'Invalid JWT payload JSON' };
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // 有効期限 (exp)
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) {
    return { ok: false, reason: 'JWT is expired' };
  }

  // 利用開始日時 (nbf, 存在する場合)
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec) {
    return { ok: false, reason: 'JWT not yet active' };
  }

  const { certsUrl, expectedIssuer } = normalizeTeamDomain(teamDomain);

  // 発行者 (iss)
  if (payload.iss !== expectedIssuer) {
    return { ok: false, reason: `Issuer mismatch (expected: ${expectedIssuer}, actual: ${payload.iss})` };
  }

  // Audience (aud)
  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAud)
    : payload.aud === expectedAud;

  if (!audMatches) {
    return { ok: false, reason: 'Audience mismatch' };
  }

  // C. 署名検証 (Signature)
  let keys = await getAccessJwks(certsUrl);
  let matchingKey = keys.find((k) => k.kid === header.kid);

  // キーローテーション等で見つからない場合は1回強制再取得
  if (!matchingKey) {
    keys = await getAccessJwks(certsUrl, true);
    matchingKey = keys.find((k) => k.kid === header.kid);
  }

  if (!matchingKey) {
    return { ok: false, reason: `No matching public key found for kid: ${header.kid}` };
  }

  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      matchingKey,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify']
    );

    const dataToVerify = toArrayBuffer(new TextEncoder().encode(`${headerB64}.${payloadB64}`));
    const signatureBuffer = toArrayBuffer(base64UrlDecode(signatureB64));

    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBuffer,
      dataToVerify
    );

    if (!isValid) {
      return { ok: false, reason: 'Signature verification failed' };
    }
  } catch (err) {
    return { ok: false, reason: `Crypto error: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { ok: true };
}

/**
 * GET ハンドラー
 */
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Pages Secrets の完全性検証 (fail-closed: 未設定時は設定を一切返さない)
  const teamDomain = env.SAKE_ACCESS_TEAM_DOMAIN ? env.SAKE_ACCESS_TEAM_DOMAIN.trim() : '';
  const expectedAud = env.SAKE_ACCESS_AUD ? env.SAKE_ACCESS_AUD.trim() : '';
  const gasUrl = env.SAKE_GAS_URL ? env.SAKE_GAS_URL.trim() : '';
  const passphrase = env.SAKE_GAS_PASSPHRASE ? env.SAKE_GAS_PASSPHRASE.trim() : '';

  if (!teamDomain || !expectedAud || !gasUrl || !passphrase) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Server configuration error: required secrets are missing (SAKE_ACCESS_TEAM_DOMAIN, SAKE_ACCESS_AUD, SAKE_GAS_URL, SAKE_GAS_PASSPHRASE)',
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

  // 2. Cloudflare Access JWT ヘッダーの取得
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Forbidden: Missing Cf-Access-Jwt-Assertion header',
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

  // 3. JWT の署名・issuer・audience・有効期限の検証
  try {
    const result = await verifyCloudflareAccessJwt(jwt, teamDomain, expectedAud);
    if (!result.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Forbidden: JWT verification failed (${result.reason || 'unauthorized'})`,
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
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `Internal Server Error during token verification: ${err instanceof Error ? err.message : String(err)}`,
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

  // 4. 検証成功時のみ同期設定を返却 (no-store 強制)
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
