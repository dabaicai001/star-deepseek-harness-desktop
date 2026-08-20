/**
 * 凭据加密工具 (Web Crypto API)
 *
 * 算法:AES-GCM-256
 * Key 派生:PBKDF2(SHA-256, 100k 轮) 从主密码 + salt
 *
 * 简化方案 v1:用固定的"主密码"做 key material(不是用户主密码,
 * 而是 app 写死的 passphrase + device 指纹)。优点:不打断用户体验;
 * 缺点:被反编译的 attacker 拿到源码能解。v0.5 升级到 Tauri keyring
 * 或用户主密码方案。
 *
 * 加密结果格式(JSON 字符串):`{"v":1,"iv":"<base64>","ct":"<base64>"}`
 *  - v: 版本号,以后算法升级可读旧格式
 *  - iv: 12 字节随机 IV
 *  - ct: 密文(包含 GCM auth tag)
 */

const ALGO = 'AES-GCM'
const KEY_LEN = 256
const PBKDF2_ITER = 100_000

// app 写死的 passphrase(粗粒度防护,不是终极安全)
// v0.5 升级:用户首次启动设置主密码 + 设备 keyring
const APP_PASSPHRASE = 'starhub.app.v0.3.0.secure.credential.vault'
const APP_SALT = 'starhub.app.v0.3.0.salt'

let cachedKey: CryptoKey | null = null

/** 派生 AES key(缓存,避免每次加解密都跑 PBKDF2) */
async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Web Crypto API 不可用,无法加密')
  }
  const enc = new TextEncoder()
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(APP_PASSPHRASE),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  cachedKey = await window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(APP_SALT),
      iterations: PBKDF2_ITER,
      hash: 'SHA-256'
    },
    baseKey,
    { name: ALGO, length: KEY_LEN },
    false,
    ['encrypt', 'decrypt']
  )
  return cachedKey
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes
}

export interface EncryptedBlob {
  v: 1
  iv: string
  ct: string
}

/** 加密任意字符串,返回 JSON 字符串(可直接存 localStorage) */
export async function encrypt(plaintext: string): Promise<string> {
  if (!plaintext) return ''
  const key = await getKey()
  const iv = window.crypto.getRandomValues(new Uint8Array(12))
  const ct = await window.crypto.subtle.encrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource
  )
  const blob: EncryptedBlob = {
    v: 1,
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct))
  }
  return JSON.stringify(blob)
}

/** 解密;输入不是加密格式(版本不对/损坏)时返回原值,避免数据锁死 */
export async function decrypt(payload: string): Promise<string> {
  if (!payload) return ''
  let blob: EncryptedBlob
  try {
    const parsed = JSON.parse(payload)
    if (parsed?.v !== 1 || typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') {
      return payload
    }
    blob = parsed
  } catch {
    return payload
  }
  try {
    const key = await getKey()
    const pt = await window.crypto.subtle.decrypt(
      { name: ALGO, iv: fromB64(blob.iv) as BufferSource },
      key,
      fromB64(blob.ct) as BufferSource
    )
    return new TextDecoder().decode(pt)
  } catch {
    return ''
  }
}

/** 清除缓存的 key(用户改主密码后调用,或调试用) */
export function clearKeyCache() {
  cachedKey = null
}
