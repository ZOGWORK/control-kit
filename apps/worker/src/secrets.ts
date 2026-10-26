/** AES-GCM sealing for tokens kept in KV, and HMAC-signed short-lived cookies, both keyed from SESSION_ENCRYPTION_KEY. */
type KeyEnv = { SESSION_ENCRYPTION_KEY: string };
const encode = new TextEncoder();
const decode = new TextDecoder();
export const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
export const bytes = (data: string) => Uint8Array.from(atob(data), x => x.charCodeAt(0));
const b64url = (data: Uint8Array) => b64(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (data: string) => bytes(data.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - data.length % 4) % 4));

async function aesKey(env: KeyEnv) {
  const raw = bytes(env.SESSION_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must contain 32 base64-encoded bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(env: KeyEnv, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), encode.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(new Uint8Array(body))}`;
}
export async function unseal<T>(env: KeyEnv, value: string): Promise<T> {
  const [iv, body] = value.split('.');
  return JSON.parse(decode.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, await aesKey(env), bytes(body)))) as T;
}

/** An HMAC key per purpose (`label`), derived from the session key so no new secret is needed. */
async function hmacKey(env: KeyEnv, label: string) {
  const material = await crypto.subtle.digest('SHA-256', new Uint8Array([...encode.encode(label), ...bytes(env.SESSION_ENCRYPTION_KEY)]));
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export type SignedCookie = { name: string; path: string; label: string };
/** A signed, HttpOnly cookie holding `data` for ten minutes. */
export async function signedCookie(env: KeyEnv, cookie: SignedCookie, data: unknown) {
  const payload = encode.encode(JSON.stringify({ exp: Date.now() + 600_000, data }));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env, cookie.label), payload));
  return `${cookie.name}=${b64url(payload)}.${b64url(signature)}; HttpOnly; Secure; SameSite=None; Path=${cookie.path}; Max-Age=600`;
}
export const clearCookie = (cookie: SignedCookie) => `${cookie.name}=; HttpOnly; Secure; SameSite=None; Path=${cookie.path}; Max-Age=0`;
/** The cookie's data when its signature is valid and it has not expired, otherwise null. */
export async function readSignedCookie<T>(request: Request, env: KeyEnv, cookie: SignedCookie): Promise<T | null> {
  return (await readSignedEnvelope<T>(request, env, cookie))?.data ?? null;
}
/** The whole signed body (`exp`, `data`, and any field an older format kept beside them) while valid, otherwise null. */
export async function readSignedEnvelope<T>(request: Request, env: KeyEnv, cookie: SignedCookie): Promise<({ exp: number; data: T } & Record<string, unknown>) | null> {
  const value = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${cookie.name}=([^;]+)`))?.[1];
  const [payload, signature] = value?.split('.') ?? [];
  if (!payload || !signature) return null;
  try {
    const body = fromB64url(payload);
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env, cookie.label), fromB64url(signature), body)) return null;
    const parsed = JSON.parse(decode.decode(body)) as { exp: number; data: T } & Record<string, unknown>;
    return parsed.exp > Date.now() ? parsed : null;
  } catch { return null; }
}
