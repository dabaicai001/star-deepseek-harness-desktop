// @vitest-environment jsdom
/**
 * NewConnectionDialog(壳内连接小对话框):新建(create_asset 契约)/编辑
 * (预填 + 留空密码不提交)/删除两步确认/错误与 busy 态/浏览器预览禁用。
 * IPC 走 window.__TAURI_INTERNALS__ stub,断言与 src/services/asset.ts
 * 相同的 create_asset/update_asset/delete_asset 入参形态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NewConnectionDialog } from '../src/client/NewConnectionDialog.tsx'
import type { RustAsset } from '../src/client/store.ts'

/** jsdom 全局下的 Tauri IPC stub:按命令路由到 handlers。 */
function stubTauriInternals(handlers: Record<string, (args?: unknown) => unknown>): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      const handler = handlers[cmd]
      if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${cmd}`))
      return Promise.resolve(handler(args))
    },
  }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

/** 构造一个完整 RustAsset(编辑模式预填用)。 */
function makeAsset(over: Partial<RustAsset> & { config: Record<string, unknown> }): RustAsset {
  return {
    id: 'a1', type: 'ssh', name: 'web-1', group_id: null, key_id: null,
    tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  delete w.__TAURI_INTERNALS__
})

describe('NewConnectionDialog create', () => {
  it('creates an ssh password asset with the embed-compatible config contract', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: (args) => create(args) })
    const onClose = vi.fn()
    const onSaved = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={onSaved} />)
      // 缺 name/host/username → 创建禁用
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'web-1' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: '10.0.0.5' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'deploy' } })
      fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'pw' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      expect(onSaved).toHaveBeenCalledTimes(1)
      expect(create).toHaveBeenCalledWith({
        params: {
          type: 'ssh',
          name: 'web-1',
          group_id: null,
          config: {
            host: '10.0.0.5', port: 22, username: 'deploy',
            authMode: 'password', usePasswordAuth: true, useKeyAuth: false,
            password: 'pw', privateKey: undefined, passphrase: undefined,
          },
          tags: [],
        },
      })
    } finally {
      restore()
    }
  })

  it('switches kind to mysql (default port) and submits a db asset', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: (args) => create(args) })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'mysql' } })
      expect((screen.getByLabelText('端口') as HTMLInputElement).value).toBe('3306')
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'orders' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'db.internal' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'root' } })
      fireEvent.change(screen.getByLabelText('数据库(可空)'), { target: { value: 'shop' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      const args = create.mock.calls[0]![0] as { params: { type: string; config: Record<string, unknown> } }
      expect(args.params.type).toBe('db')
      expect(args.params.config).toMatchObject({
        dbType: 'mysql', host: 'db.internal', port: 3306, username: 'root', database: 'shop', ssl: false,
      })
    } finally {
      restore()
    }
  })

  it('submits a redis asset with db index and no username field', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: (args) => create(args) })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'redis' } })
      expect(screen.queryByLabelText(/用户名/)).toBeNull()
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'cache' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: '127.0.0.1' } })
      fireEvent.change(screen.getByLabelText('DB 索引'), { target: { value: '2' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      const args = create.mock.calls[0]![0] as { params: { config: Record<string, unknown> } }
      expect(args.params.config).toMatchObject({ dbType: 'redis', port: 6379, db: 2 })
      expect('username' in args.params.config ? args.params.config.username : undefined).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('submits a docker tcp asset and a socket asset with the default path', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: (args) => create(args) })
    try {
      const onClose1 = vi.fn()
      const view = render(<NewConnectionDialog asset={null} onClose={onClose1} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'docker' } })
      // socket 模式:地址留空 → 缺省 /var/run/docker.sock
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'local-docker' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() => expect(onClose1).toHaveBeenCalledTimes(1))
      expect((create.mock.calls[0]![0] as { params: { config: Record<string, unknown> } }).params.config)
        .toMatchObject({ dockerTransport: 'socket', socketPath: '/var/run/docker.sock' })
      view.unmount()
      const onClose2 = vi.fn()
      render(<NewConnectionDialog asset={null} onClose={onClose2} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'docker' } })
      fireEvent.change(screen.getByLabelText('连接方式'), { target: { value: 'tcp' } })
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'remote-docker' } })
      fireEvent.change(screen.getByLabelText('地址 *'), { target: { value: 'tcp://10.0.0.9:2375' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() => expect(onClose2).toHaveBeenCalledTimes(1))
      expect((create.mock.calls[1]![0] as { params: { config: Record<string, unknown> } }).params.config)
        .toMatchObject({ dockerTransport: 'tcp', remoteHost: 'tcp://10.0.0.9:2375' })
    } finally {
      restore()
    }
  })

  it('keeps the dialog open and shows the error when create fails', async () => {
    const restore = stubTauriInternals({ create_asset: () => { throw new Error('dup name') } })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'x' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      fireEvent.click(screen.getByText('创建'))
      expect(await screen.findByText('dup name')).toBeTruthy()
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})

describe('NewConnectionDialog edit / delete', () => {
  it('prefills from the asset, omits a blank password on update and disables the kind select', async () => {
    const update = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ update_asset: (args) => update(args) })
    const onClose = vi.fn()
    try {
      const asset = makeAsset({ config: { host: '10.0.0.5', port: 2222, username: 'deploy' } })
      render(<NewConnectionDialog asset={asset} onClose={onClose} onSaved={() => {}} />)
      expect((screen.getByLabelText('类型') as HTMLSelectElement).disabled).toBe(true)
      expect((screen.getByLabelText('名称 *') as HTMLInputElement).value).toBe('web-1')
      expect((screen.getByLabelText('端口') as HTMLInputElement).value).toBe('2222')
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'web-1b' } })
      fireEvent.click(screen.getByText('保存'))
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      const args = update.mock.calls[0]![0] as { id: string; params: { name: string; config: Record<string, unknown> } }
      expect(args.id).toBe('a1')
      expect(args.params.name).toBe('web-1b')
      // 密码留空 → 不提交(后端 merge 保持原值)
      expect(args.params.config.password).toBeUndefined()
      expect(args.params.config.host).toBe('10.0.0.5')
    } finally {
      restore()
    }
  })

  it('deletes through the two-step confirm and keeps the dialog on failure', async () => {
    let calls = 0
    const restore = stubTauriInternals({
      delete_asset: () => {
        calls += 1
        if (calls === 1) throw 'delete raw'
        return null
      },
    })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={makeAsset({ config: {} })} onClose={onClose} onSaved={() => {}} />)
      fireEvent.click(screen.getByText('删除连接'))
      expect(screen.getByText('确认删除?')).toBeTruthy()
      fireEvent.click(screen.getByText('确认删除?'))
      expect(await screen.findByText('delete raw')).toBeTruthy()
      // 失败后回到未确认态,再确认一次成功
      fireEvent.click(screen.getByText('删除连接'))
      fireEvent.click(screen.getByText('确认删除?'))
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    } finally {
      restore()
    }
  })

  it('detects key-auth assets and the broker dbType for the kind select', () => {
    render(<NewConnectionDialog
      asset={makeAsset({ config: { authMode: 'key' } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText('认证方式') as HTMLSelectElement).value).toBe('key')
    cleanup()
    render(<NewConnectionDialog
      asset={makeAsset({ type: 'db', config: { dbType: 'kafka', host: 'k', port: 9092 } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText('类型') as HTMLSelectElement).value).toBe('kafka')
    cleanup()
    // 未知 dbType → 回退 mysql
    render(<NewConnectionDialog
      asset={makeAsset({ type: 'db', config: { dbType: 'oracle' } })}
      onClose={() => {}}
      onSaved={() => {}}
    />)
    expect((screen.getByLabelText('类型') as HTMLSelectElement).value).toBe('mysql')
  })
})

describe('NewConnectionDialog preview / misc', () => {
  it('disables inputs and shows the preview hint without Tauri internals', () => {
    render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
    expect(screen.getByText(/浏览器预览模式/)).toBeTruthy()
    expect((screen.getByLabelText('名称 *') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
  })

  it('closes via the header close button, the backdrop and the cancel button', () => {
    const onClose = vi.fn()
    const view = render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(view.container.querySelector('[role="presentation"]')!)
    expect(onClose).toHaveBeenCalledTimes(2)
    // panel 内 mousedown 不冒泡关闭
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('loads a private key file through FileReader and submits key auth', async () => {
    const create = vi.fn((..._args: unknown[]) => ({}))
    const restore = stubTauriInternals({ create_asset: (args) => create(args) })
    const onClose = vi.fn()
    try {
      render(<NewConnectionDialog asset={null} onClose={onClose} onSaved={() => {}} />)
      fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'key' } })
      fireEvent.change(screen.getByLabelText('名称 *'), { target: { value: 'k1' } })
      fireEvent.change(screen.getByLabelText('主机 *'), { target: { value: 'h' } })
      fireEvent.change(screen.getByLabelText('用户名 *'), { target: { value: 'u' } })
      // 未选私钥 → 创建禁用
      expect(screen.getByText('创建').hasAttribute('disabled')).toBe(true)
      const file = new File(['---KEY---'], 'id_rsa', { type: 'text/plain' })
      fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [file] } })
      await act(async () => { await Promise.resolve() })
      await screen.findByText('id_rsa')
      fireEvent.change(screen.getByLabelText('私钥口令(可空)'), { target: { value: 'pp' } })
      fireEvent.click(screen.getByText('创建'))
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      const config = (create.mock.calls[0]![0] as { params: { config: Record<string, unknown> } }).params.config
      expect(config).toMatchObject({ authMode: 'key', useKeyAuth: true, privateKey: '---KEY---', passphrase: 'pp' })
    } finally {
      restore()
    }
  })

  it('rejects an oversized private key file', async () => {
    render(<NewConnectionDialog asset={null} onClose={() => {}} onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText('认证方式'), { target: { value: 'key' } })
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.pem')
    fireEvent.change(screen.getByLabelText('私钥文件'), { target: { files: [big] } })
    expect(await screen.findByText('私钥文件超过 2MB')).toBeTruthy()
  })
})
