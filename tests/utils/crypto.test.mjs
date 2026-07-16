import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// Polyfill window for Web Crypto API (Node 18+ has globalThis.crypto)
globalThis.window = globalThis

const source = await readFile(new URL('../../src/utils/crypto.ts', import.meta.url), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const cryptoModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { encrypt, decrypt, clearKeyCache } = cryptoModule

test('encrypt returns empty string for empty plaintext', async () => {
  const result = await encrypt('')
  assert.equal(result, '')
})

test('decrypt returns empty string for empty payload', async () => {
  const result = await decrypt('')
  assert.equal(result, '')
})

test('encrypt then decrypt round-trips correctly', async () => {
  clearKeyCache()
  const plaintext = 'postgres://user:p@ssw0rd@10.0.0.1:5432/mydb'
  const encrypted = await encrypt(plaintext)
  assert.notEqual(encrypted, plaintext)
  const decrypted = await decrypt(encrypted)
  assert.equal(decrypted, plaintext)
})

test('decrypt of non-JSON payload returns the original string', async () => {
  const original = 'not-an-encrypted-blob'
  const result = await decrypt(original)
  assert.equal(result, original)
})

test('decrypt of malformed JSON returns the original string', async () => {
  const malformed = '{not valid json'
  const result = await decrypt(malformed)
  assert.equal(result, malformed)
})

test('decrypt of blob with wrong version returns the original string', async () => {
  const wrongVersion = JSON.stringify({ v: 99, iv: 'abc', ct: 'def' })
  const result = await decrypt(wrongVersion)
  assert.equal(result, wrongVersion)
})

test('encrypted blob has expected structure', async () => {
  clearKeyCache()
  const encrypted = await encrypt('secret-data')
  const blob = JSON.parse(encrypted)
  assert.equal(blob.v, 1)
  assert.equal(typeof blob.iv, 'string')
  assert.equal(typeof blob.ct, 'string')
  assert.ok(blob.iv.length > 0)
  assert.ok(blob.ct.length > 0)
})

test('encrypting the same plaintext produces different ciphertexts (random IV)', async () => {
  clearKeyCache()
  const plaintext = 'same-secret'
  const enc1 = await encrypt(plaintext)
  const enc2 = await encrypt(plaintext)
  assert.notEqual(enc1, enc2)
  const blob1 = JSON.parse(enc1)
  const blob2 = JSON.parse(enc2)
  assert.notEqual(blob1.iv, blob2.iv)
})

test('decrypt of corrupted ciphertext returns empty string', async () => {
  clearKeyCache()
  const encrypted = await encrypt('some-data')
  const blob = JSON.parse(encrypted)
  // Tamper with the ciphertext
  blob.ct = blob.ct.slice(0, -4) + 'AAAA'
  const result = await decrypt(JSON.stringify(blob))
  assert.equal(result, '')
})
