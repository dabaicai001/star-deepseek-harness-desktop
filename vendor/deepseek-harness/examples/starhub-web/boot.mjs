#!/usr/bin/env node
/**
 * Boot the StarHub web composition: dsh web profile (dsh-base + dsh-web-app
 * bundle layers) plus the StarHub client-nav row from this example's
 * cordis.patch.yml.
 *
 * What it does:
 * 1. Materializes $DSH_HOME/profiles/web/ (default <starhub repo>/tmp/dsh-web-home,
 *    override with DSH_HOME) from this directory's package.json (profile
 *    manifest) and cordis.patch.yml (user patch layer).
 * 2. Junctions the StarHub-local packages (client-nav, host-static) into the
 *    launcher-maintained flat fallback $DSH_HOME/profiles/node_modules — local
 *    packages are not in the dsh app's dependency closure, so
 *    healProfilesModuleFallback never links them on its own.
 * 3. Spawns the built dsh CLI (`apps/cli/lib/bin.js web`) with stdio inherited.
 *
 * Prerequisites: `pnpm run build` (host + client libs and the apps/web dist).
 * DEEPSEEK_API_KEY is passed through; a placeholder is fine for boot checks —
 * no session is started by serving the GUI.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..') // vendor/deepseek-harness
const starhubRoot = join(repoRoot, '..', '..')

const dshHome = process.env.DSH_HOME ?? join(starhubRoot, 'tmp', 'dsh-web-home')
const profileDir = join(dshHome, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
copyFileSync(join(here, 'package.json'), join(profileDir, 'package.json'))
copyFileSync(join(here, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))

const linkBase = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
mkdirSync(linkBase, { recursive: true })
for (const pkg of ['dsh-starhub-client-nav', 'dsh-starhub-host-static']) {
  const link = join(linkBase, pkg)
  const target = join(repoRoot, 'packages', 'starhub', pkg.replace('dsh-starhub-', ''))
  if (existsSync(link)) {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
    else throw new Error(`boot: ${link} exists and is not a symlink; remove it manually`)
  }
  symlinkSync(target, link, 'junction')
}

const bin = join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
if (!existsSync(bin)) throw new Error('boot: apps/cli/lib/bin.js missing; run pnpm run build first')

const child = spawn(process.execPath, [bin, 'web'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? '1',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'starhub-p0-placeholder',
  },
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 0))
})
