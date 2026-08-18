import { describe, expect, it } from 'vitest'
import { parseWindowParams, workbenchForRouteName, isWindowWorkbench, workbenchForAsset } from '../src/route.ts'
import type { RustAsset } from '@deepseek-ai/dsh-starhub-client-nav/src/client/store.ts'

function asset(type: string, dbType?: string): RustAsset {
  return {
    id: 'a1', type, name: 'n', group_id: null,
    config: dbType === undefined ? {} : { dbType },
    key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
  }
}

describe('parseWindowParams', () => {
  it('parses asset id and a known workbench hint', () => {
    expect(parseWindowParams('?asset=a1__1&workbench=ssh')).toEqual({ assetId: 'a1__1', workbench: 'ssh' })
  })

  it('tolerates a bare search without a leading ?', () => {
    expect(parseWindowParams('asset=a1&workbench=docker')).toEqual({ assetId: 'a1', workbench: 'docker' })
  })

  it('returns null when the asset id is missing or blank', () => {
    expect(parseWindowParams('')).toBeNull()
    expect(parseWindowParams('?workbench=ssh')).toBeNull()
    expect(parseWindowParams('?asset=   ')).toBeNull()
  })

  it('yields null workbench for an unknown hint', () => {
    expect(parseWindowParams('?asset=a1&workbench=nope')).toEqual({ assetId: 'a1', workbench: null })
  })
})

describe('workbenchForRouteName', () => {
  it('maps every supported route to a workbench kind', () => {
    expect(workbenchForRouteName('ssh-terminal')).toBe('ssh')
    expect(workbenchForRouteName('db-broker')).toBe('ssh')
    expect(workbenchForRouteName('db-mysql')).toBe('db-mysql')
    expect(workbenchForRouteName('db-postgresql')).toBe('db-postgresql')
    expect(workbenchForRouteName('db-clickhouse')).toBe('db-clickhouse')
    expect(workbenchForRouteName('db-redis')).toBe('db-redis')
    expect(workbenchForRouteName('docker')).toBe('docker')
  })

  it('returns null for routes with no React workbench', () => {
    expect(workbenchForRouteName('db-elasticsearch')).toBeNull()
    expect(workbenchForRouteName('local')).toBeNull()
    expect(workbenchForRouteName('???')).toBeNull()
  })
})

describe('isWindowWorkbench', () => {
  it('accepts all kinds and rejects junk/null', () => {
    for (const k of ['ssh', 'db-mysql', 'db-postgresql', 'db-clickhouse', 'db-redis', 'docker']) {
      expect(isWindowWorkbench(k)).toBe(true)
    }
    expect(isWindowWorkbench('nope')).toBe(false)
    expect(isWindowWorkbench(null)).toBe(false)
    expect(isWindowWorkbench(undefined)).toBe(false)
  })
})

describe('workbenchForAsset', () => {
  it('routes a hydrated asset by its route name', () => {
    expect(workbenchForAsset(asset('ssh'))).toBe('ssh')
    expect(workbenchForAsset(asset('docker'))).toBe('docker')
    expect(workbenchForAsset(asset('db', 'mysql'))).toBe('db-mysql')
    expect(workbenchForAsset(asset('db', 'redis'))).toBe('db-redis')
  })

  it('returns null for assets without a React workbench', () => {
    expect(workbenchForAsset(asset('db', 'elasticsearch'))).toBeNull()
    expect(workbenchForAsset(asset('local'))).toBeNull()
  })
})
