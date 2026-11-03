import type { Envelope } from "./types";

const PBKDF2_ITERATIONS = 600_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toB64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function newKdf(): Envelope["kdf"] {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { alg: "PBKDF2-SHA-256", iterations: PBKDF2_ITERATIONS, salt: toB64(salt) };
}

/**
 * 由口令派生 AES-GCM 主密钥。
 * extractable=false：密钥不可导出，可安全放进 IndexedDB 缓存（本设备记住）。
 */
export async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", textEncoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJSON(key: CryptoKey, value: unknown): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = textEncoder.encode(JSON.stringify(value));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: toB64(iv), ct: toB64(buf) };
}

export async function decryptJSON<T>(key: CryptoKey, env: Envelope): Promise<T> {
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(env.iv) }, key, fromB64(env.ct));
  return JSON.parse(textDecoder.decode(buf)) as T;
}

export function cacheIdOf(userId: string, env: Envelope): string {
  return `${userId}|${env.kdf.salt}|${env.kdf.iterations}`;
}
