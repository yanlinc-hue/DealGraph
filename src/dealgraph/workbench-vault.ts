import { MAX_VAULT_BYTES, validateWorkbench } from './workbench-state.ts';
import type { Workbench } from './workbench-state.ts';

const VERSION = 'dealgraph.encrypted-workbench.v1';
const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const aad = encoder.encode(`${VERSION}|PBKDF2-SHA256|${ITERATIONS}|AES-256-GCM`);
function encode(bytes: Uint8Array): string { let s = ''; for (let offset = 0; offset < bytes.length; offset += 8192) s += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(s); }
function decode(s: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (typeof s !== 'string' || s.length > max * 4 / 3 + 4 || s.length % 4 !== 0) throw new Error('加密文件格式不正确。');
  let data: Uint8Array<ArrayBuffer>;
  try { data = Uint8Array.from(atob(s), c => c.charCodeAt(0)); } catch { throw new Error('加密文件格式不正确。'); }
  if (data.byteLength > max || encode(data) !== s) throw new Error('加密文件格式不正确。'); return data;
}
async function key(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (password.length < 12 || password.length > 256) throw new Error('请使用 12–256 个字符的保存密码。');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptWorkbench(state: Workbench, password: string): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(validateWorkbench(state)));
  if (bytes.length > 10 * 1024 * 1024) throw new Error('工作台超过 10 MB，请拆分保存。');
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, await key(password, salt), bytes);
    return JSON.stringify({ schema: VERSION, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, cipher: 'AES-256-GCM', salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
  } finally { bytes.fill(0); }
}
export async function decryptWorkbench(text: string, password: string): Promise<Workbench> {
  if (encoder.encode(text).length > MAX_VAULT_BYTES) throw new Error('请选择 16 MB 以内的加密工作台文件。');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('加密文件格式不正确。'); }
  if (!data || typeof data !== 'object' || data.schema !== VERSION || data.kdf !== 'PBKDF2-SHA256' || data.iterations !== ITERATIONS || data.cipher !== 'AES-256-GCM') throw new Error('不支持此加密文件版本。');
  const salt = decode(data.salt, 16), iv = decode(data.iv, 12), ciphertext = decode(data.ciphertext, 10 * 1024 * 1024 + 16);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) throw new Error('加密文件格式不正确。');
  let plaintext;
  try { plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, await key(password, salt), ciphertext)); }
  catch { throw new Error('密码不正确或文件已损坏；当前工作台未更改。'); }
  try { return validateWorkbench(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))); }
  finally { plaintext.fill(0); }
}
