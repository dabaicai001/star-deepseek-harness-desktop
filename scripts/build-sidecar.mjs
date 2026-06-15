import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, '..')
const sidecarDir = join(projectRoot, 'sidecar')
const binDir = join(sidecarDir, 'bin')
const release = process.argv.includes('--release')
const targetOS = process.env.GOOS || ({ win32: 'windows', darwin: 'darwin' }[process.platform] ?? 'linux')
const outputName = `starhub-sidecar${targetOS === 'windows' ? '.exe' : ''}`
const outputPath = join(binDir, outputName)
const ldflags = ['-s', '-w']

if (release && targetOS === 'windows') {
  ldflags.push('-H', 'windowsgui')
}

mkdirSync(binDir, { recursive: true })
console.log(`Building sidecar for ${targetOS}/${process.env.GOARCH || 'native'}...`)

const result = spawnSync(
  'go',
  ['build', '-ldflags', ldflags.join(' '), '-o', outputPath, '.'],
  {
    cwd: sidecarDir,
    env: { ...process.env, CGO_ENABLED: '0' },
    stdio: 'inherit'
  }
)

if (result.error) {
  throw result.error
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const targetDebug = join(projectRoot, 'src-tauri', 'target', 'debug')
if (existsSync(targetDebug)) {
  copyFileSync(outputPath, join(targetDebug, outputName))
}

console.log(`Sidecar built: ${outputPath}`)
