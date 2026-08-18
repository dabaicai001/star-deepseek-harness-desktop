// @vitest-environment jsdom
/**
 * Docker 工作台组件(DockerWorkbench.tsx):连接生命周期、容器/镜像列表、行操作、
 * 展开详情(日志/统计)、拉取/删除/清理、exec 弹层,以及加载/空态/错误分支。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const xterm = vi.hoisted(() => ({
  dispose: vi.fn(),
  input: undefined as ((data: string) => void) | undefined,
  write: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    focus() {}
    dispose = xterm.dispose
    write = xterm.write
    onData(handler: (data: string) => void) {
      xterm.input = handler
      return { dispose: vi.fn() }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

import { DockerWorkbench, formatAge } from '../src/client/docker/DockerWorkbench.tsx'

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const asset = {
  id: 'd1', type: 'docker', name: 'docker-1', group_id: null,
  config: { dockerTransport: 'socket', socketPath: '/var/run/docker.sock' },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}

const running = { id: 'c1', name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 2h', created: 0, ports: [{ private: 80, public: 8080, type: 'tcp' }], labels: {} }
const stopped = { id: 'c2', name: 'db', image: 'postgres:15', state: 'exited', status: 'Exited (0)', created: 0, ports: [], labels: {} }
const image = { id: 'img1', tags: ['nginx:latest'], size: 10 * 1024 * 1024, created: 0 }
const stats = { cpuPercent: 1.2, memoryUsage: 1024, memoryLimit: 8192, memoryPercent: 12.5, netRx: 100, netTx: 50, blockRead: 10, blockWrite: 5, pids: 3 }
const logLine = { timestamp: '2026-01-01', stream: 'stdout', message: 'hello' }

/** 安装 Tauri 调用分发 stub;`opts` 可覆盖各命令返回。 */
function installTauri(opts?: { connectError?: unknown; listContainersError?: unknown; listImagesError?: unknown; logsError?: unknown; statsError?: unknown; pullError?: unknown; removeImageError?: unknown; pruneError?: unknown }) {
  const invoke = vi.fn((cmd: string) => {
    switch (cmd) {
      case 'docker_connect': return opts?.connectError ? Promise.reject(opts.connectError) : Promise.resolve({ connId: 'c', host: 'h' })
      case 'docker_list_containers': return opts?.listContainersError ? Promise.reject(opts.listContainersError) : Promise.resolve([running, stopped])
      case 'docker_list_images': return opts?.listImagesError ? Promise.reject(opts.listImagesError) : Promise.resolve([image])
      case 'docker_container_logs': return opts?.logsError ? Promise.reject(opts.logsError) : Promise.resolve([logLine])
      case 'docker_container_stats': return opts?.statsError ? Promise.reject(opts.statsError) : Promise.resolve(stats)
      case 'docker_start_container':
      case 'docker_stop_container':
      case 'docker_restart_container':
      case 'docker_remove_container':
        return Promise.resolve(null)
      case 'docker_remove_image': return opts?.removeImageError ? Promise.reject(opts.removeImageError) : Promise.resolve(null)
      case 'docker_prune_images': return opts?.pruneError ? Promise.reject(opts.pruneError) : Promise.resolve(null)
      case 'docker_pull_image': return opts?.pullError ? Promise.reject(opts.pullError) : Promise.resolve(null)
      case 'docker_exec_session_close':
        return Promise.resolve(null)
      default: return Promise.resolve(null)
    }
  })
  ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
  return invoke
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  xterm.dispose.mockReset()
  xterm.input = undefined
  xterm.write.mockReset()
})

function renderWorkbench() {
  return render(<DockerWorkbench asset={asset} onClose={vi.fn()} />)
}

describe('DockerWorkbench', () => {
  it('connects on mount, loads lists, and renders the dashboard + running rows', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    renderWorkbench()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_connect', { params: { transport: 'socket', socketPath: '/var/run/docker.sock' } }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_list_containers', { connId: 'c', all: false }))
    // dashboard counts + running row (exited 默认隐藏)
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    expect(screen.queryByText('db')).toBeNull()
    expect(screen.getByText('nginx:latest')).toBeTruthy()
  })

  it('shows a config error and a close back for an empty tcp host', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const onClose = vi.fn()
    render(<DockerWorkbench asset={{ ...asset, config: { dockerTransport: 'tcp', remoteHost: '' } }} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/Docker 资产配置不完整/)).toBeTruthy())
    fireEvent.click(screen.getByText('返回'))
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a connect rejection with a back action', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const onClose = vi.fn()
    installTauri({ connectError: new Error('boom') })
    render(<DockerWorkbench asset={asset} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy())
    fireEvent.click(screen.getByText('返回'))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows loading then an empty state when no containers exist', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('暂无容器。')).toBeTruthy())
    // 切到镜像空态
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText('暂无镜像。')).toBeTruthy())
  })

  it('surfaces a container-list error with retry', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri({ listContainersError: new Error('list-fail') })
    renderWorkbench()
    await waitFor(() => expect(screen.getByText(/加载失败:list-fail/)).toBeTruthy())
    // retry 再失败一次(稳定)
    fireEvent.click(screen.getByText('重试'))
    expect(invoke).toHaveBeenCalledWith('docker_list_containers', { connId: 'c', all: false })
  })

  it('hides non-running rows unless 显示全部 is toggled', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    // 默认只看运行中 → db(exited) 不显示
    expect(screen.queryByText('db')).toBeNull()
    fireEvent.click(screen.getByText('显示全部'))
    await waitFor(() => expect(screen.getByText('db')).toBeTruthy())
  })

  it('shows the no-running hint when only stopped containers exist', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([stopped])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText(/没有运行中的容器/)).toBeTruthy())
  })

  it('runs container start/stop actions and shows a toast', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    // stop(web running → 停止可用)
    fireEvent.click(screen.getByLabelText('停止'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_stop_container', expect.objectContaining({ containerId: 'c1' })))
    // restart
    fireEvent.click(screen.getByLabelText('重启'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_restart_container', expect.objectContaining({ containerId: 'c1' })))
  })

  it('start is disabled for a running container and remove guards with confirm', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    // running → start disabled
    expect((screen.getByLabelText('启动') as HTMLButtonElement).disabled).toBe(true)
    // remove canceled → not invoked
    fireEvent.click(screen.getByLabelText('删除'))
    expect(invoke).not.toHaveBeenCalledWith('docker_remove_container', expect.anything())
    // confirm true → invoked + toast
    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('删除'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_remove_container', expect.objectContaining({ containerId: 'c1' })))
    confirmSpy.mockRestore()
  })

  it('expands logs and stats details', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    // logs
    fireEvent.click(screen.getByLabelText('日志'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_container_logs', expect.objectContaining({ containerId: 'c1' })))
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy())
    // stats
    fireEvent.click(screen.getByLabelText('统计'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_container_stats', expect.objectContaining({ containerId: 'c1' })))
    await waitFor(() => expect(screen.getByText('CPU')).toBeTruthy())
  })

  it('toggles detail closed when re-selecting the same panel', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('日志'))
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('日志'))
    await waitFor(() => expect(screen.queryByText('hello')).toBeNull())
  })

  it('surfaces logs and stats errors', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installTauri({ logsError: new Error('logs-fail'), statsError: new Error('stats-fail') })
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('日志'))
    await waitFor(() => expect(screen.getByText(/日志加载失败:logs-fail/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText('统计'))
    await waitFor(() => expect(screen.getByText('stats-fail')).toBeTruthy())
  })

  it('opens the exec terminal modal with the container', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('终端'))
    await waitFor(() => expect(screen.getByText(/web · 终端/)).toBeTruthy())
    // exec session start fired by the embedded terminal
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_exec_session_start', expect.anything()))
  })

  it('pulls, removes, and prunes images from the images tab', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText('nginx:latest')).toBeTruthy())

    // 拉取:空名禁用,输入后提交
    fireEvent.click(screen.getByRole('button', { name: '拉取镜像' }))
    const input = screen.getByPlaceholderText('名称[:tag],如 nginx:latest')
    expect((screen.getByRole('button', { name: '拉取' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'redis:7' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_pull_image', { connId: 'c', imageName: 'redis:7' }))
    await waitFor(() => expect(screen.queryByPlaceholderText('名称[:tag],如 nginx:latest')).toBeNull())

    // 删除镜像
    await waitFor(() => expect(screen.getByText('nginx:latest')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('删除镜像'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_remove_image', expect.anything()))

    // prune
    fireEvent.click(screen.getByText('清理'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_prune_images', { connId: 'c' }))
    confirmSpy.mockRestore()
  })

  it('surfaces an image-list error with retry', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    installTauri({ listImagesError: new Error('img-fail') })
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText(/加载失败:img-fail/)).toBeTruthy())
  })

  it('formats a non-Error container-list rejection as a string', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.reject('plain boom')
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    // 非 Error 拒绝 → 走 String(e) 兜底
    await waitFor(() => expect(screen.getByText(/加载失败:plain boom/)).toBeTruthy())
  })

  it('surfaces a connect that returns no connId as an error', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: undefined })
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText(/Docker 连接未返回 connId/)).toBeTruthy())
  })

  it('shows the empty-logs placeholder when a container has no log lines', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      if (cmd === 'docker_container_logs') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('日志'))
    await waitFor(() => expect(screen.getByText('暂无日志。')).toBeTruthy())
  })

  it('marks stderr log lines with the error class', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      if (cmd === 'docker_container_logs') return Promise.resolve([{ timestamp: 't', stream: 'stderr', message: 'err!' }, { timestamp: 't2', stream: 'stdout', message: 'ok' }])
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('日志'))
    await waitFor(() => expect(screen.getByText('err!')).toBeTruthy())
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('shows the no-stats placeholder when stats resolve to null without an error', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      if (cmd === 'docker_container_stats') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('统计'))
    await waitFor(() => expect(screen.getByText('暂无统计。')).toBeTruthy())
  })

  it('falls back to the image id when an image has no tags', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([])
      if (cmd === 'docker_list_images') return Promise.resolve([{ id: 'sha256:abcdef123456', tags: [], size: 100, created: 0 }])
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getAllByText('sha256:abcde').length).toBeGreaterThan(0))
  })

  it('counts and displays paused containers with a null public port', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const pausedC = { id: 'c3', name: 'cache', image: 'redis:7', state: 'paused', status: 'Paused', created: 0, ports: [{ private: 6379, public: null, type: 'tcp' }], labels: {} }
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([pausedC])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText(/没有运行中的容器/)).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(screen.getByText('cache')).toBeTruthy())
    // 暂停卡计数 + 空 public 端口回退到 private
    expect(screen.getByText('6379')).toBeTruthy()
    // 行主按钮点击切换到日志展开(425)
    fireEvent.click(screen.getByText('cache'))
    await waitFor(() => expect(screen.getByText(/日志 · cache/)).toBeTruthy())
  })

  it('starts a stopped container successfully and shows the toast', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([stopped])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      if (cmd === 'docker_start_container') return Promise.resolve(null)
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText(/没有运行中的容器/)).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(screen.getByText('db')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('启动'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_start_container', { connId: 'c', containerId: 'c2' }))
    await waitFor(() => expect(screen.getByText(/已启动:db/)).toBeTruthy())
  })

  it('surfaces a container-action failure with an Error and a string', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string): Promise<unknown> => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      if (cmd === 'docker_stop_container') return Promise.reject(new Error('stop-fail'))
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('停止'))
    await waitFor(() => expect(screen.getByText(/操作失败:stop-fail/)).toBeTruthy())
    // 非 Error 拒绝 → String(e) 兜底
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      if (cmd === 'docker_stop_container') return Promise.reject('plain stop')
      return Promise.resolve(null)
    })
    fireEvent.click(screen.getByLabelText('停止'))
    await waitFor(() => expect(screen.getByText(/操作失败:plain stop/)).toBeTruthy())
  })

  it('surfaces non-Error log and stats failures and null logs', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      if (cmd === 'docker_container_logs') return Promise.reject('plain logs')
      if (cmd === 'docker_container_stats') return Promise.reject('plain stats')
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('日志'))
    await waitFor(() => expect(screen.getByText(/日志加载失败:plain logs/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText('统计'))
    await waitFor(() => expect(screen.getByText(/plain stats/)).toBeTruthy())
  })

  it('surfaces a non-Error image-list rejection via the images tab', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.reject('plain imgs')
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText(/加载失败:plain imgs/)).toBeTruthy())
    // onRefresh 重试
    const retry = screen.getByText('重试')
    fireEvent.click(retry)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_list_images', { connId: 'c' }))
  })

  it('refreshes container and image lists and toggles back to the containers tab', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    // containers 刷新(312)
    const before = invoke.mock.calls.length
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => {
      const calls = invoke.mock.calls.slice(before).filter((c) => c[0] === 'docker_list_containers')
      expect(calls.length).toBeGreaterThan(0)
    })
    // images tab + images 刷新(316)
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText('nginx:latest')).toBeTruthy())
    const beforeImg = invoke.mock.calls.length
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => {
      const calls = invoke.mock.calls.slice(beforeImg).filter((c) => c[0] === 'docker_list_images')
      expect(calls.length).toBeGreaterThan(0)
    })
    // containers tab 切回(297)
    fireEvent.click(screen.getByRole('button', { name: '容器' }))
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
  })

  it('opens and closes the exec terminal modal', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('终端'))
    await waitFor(() => expect(screen.getByText(/web · 终端/)).toBeTruthy())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_exec_session_start', expect.anything()))
    fireEvent.click(within(screen.getByLabelText('web 终端')).getByText('关闭'))
    await waitFor(() => expect(screen.queryByText(/web · 终端/)).toBeNull())
  })

  it('drives the pull modal: cancel, empty submit, button submit, and failures', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri()
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText('nginx:latest')).toBeTruthy())
    // 打开 modal
    fireEvent.click(screen.getByRole('button', { name: '拉取镜像' }))
    // 取消(356)
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(screen.queryByPlaceholderText('名称[:tag],如 nginx:latest')).toBeNull())
    // 重新打开,空名 Enter → 早退(224)
    fireEvent.click(screen.getByRole('button', { name: '拉取镜像' }))
    const reopened = screen.getByPlaceholderText('名称[:tag],如 nginx:latest')
    fireEvent.keyDown(reopened, { key: 'Enter' })
    // 空名 Enter 不触发拉取
    expect(invoke).not.toHaveBeenCalledWith('docker_pull_image', expect.anything())
    // 输入后 Enter 提交(357)
    fireEvent.change(reopened, { target: { value: 'redis:7' } })
    fireEvent.keyDown(reopened, { key: 'Enter' })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('docker_pull_image', { connId: 'c', imageName: 'redis:7' }))
  })

  it('opens the pull modal from the empty images state', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([])
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText('暂无镜像。')).toBeTruthy())
    // 空态里的「拉取镜像」走 ImagesView.onPullOpen(340);工具栏还有一个同名按钮 → 取第二个
    const buttons = screen.getAllByText('拉取镜像')
    const target = buttons[buttons.length - 1]
    if (target === undefined) throw new Error('拉取镜像 button missing')
    fireEvent.click(target)
    await waitFor(() => expect(screen.getByPlaceholderText('名称[:tag],如 nginx:latest')).toBeTruthy())
  })

  it('surfaces non-Error pull, remove, and prune failures and deletes an untagged image', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'docker_connect') return Promise.resolve({ connId: 'c', host: 'h' })
      if (cmd === 'docker_list_containers') return Promise.resolve([running])
      if (cmd === 'docker_list_images') return Promise.resolve([{ id: 'img9', tags: [], size: 10, created: 0 }])
      if (cmd === 'docker_pull_image') return Promise.reject('plain pull')
      if (cmd === 'docker_remove_image') return Promise.reject('plain rm')
      if (cmd === 'docker_prune_images') return Promise.reject('plain prune')
      return Promise.resolve(null)
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getAllByText('img9').length).toBeGreaterThan(0))
    // 拉取失败(非 Error → String)(234)
    fireEvent.click(screen.getByRole('button', { name: '拉取镜像' }))
    fireEvent.change(screen.getByPlaceholderText('名称[:tag],如 nginx:latest'), { target: { value: 'r:1' } })
    fireEvent.click(screen.getByRole('button', { name: '拉取' }))
    await waitFor(() => expect(screen.getByText(/拉取失败:plain pull/)).toBeTruthy())
    // 删除无 tag 镜像(243)+ 删除失败(非 Error)(249)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('删除镜像'))
    await waitFor(() => expect(screen.getByText(/删除失败:plain rm/)).toBeTruthy())
    // prune 失败(非 Error)(264)
    fireEvent.click(screen.getByText('清理'))
    await waitFor(() => expect(screen.getByText(/清理失败:plain prune/)).toBeTruthy())
    confirmSpy.mockRestore()
  })

  it('surfaces a pull failure, delete failure, and prune failure', async () => {
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
    const invoke = installTauri({
      pullError: new Error('pull-fail'), removeImageError: new Error('rm-fail'), pruneError: new Error('prune-fail'),
    })
    ;(window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke }
    renderWorkbench()
    await waitFor(() => expect(screen.getByText('web')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '镜像' }))
    await waitFor(() => expect(screen.getByText('nginx:latest')).toBeTruthy())
    // 拉取失败
    fireEvent.click(screen.getByRole('button', { name: '拉取镜像' }))
    fireEvent.change(screen.getByPlaceholderText('名称[:tag],如 nginx:latest'), { target: { value: 'redis:7' } })
    fireEvent.click(screen.getByRole('button', { name: '拉取' }))
    await waitFor(() => expect(screen.getByText(/拉取失败:pull-fail/)).toBeTruthy())
    // 删除取消(241)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByLabelText('删除镜像'))
    expect(invoke).not.toHaveBeenCalledWith('docker_remove_image', expect.anything())
    // 删除失败(246)
    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('删除镜像'))
    await waitFor(() => expect(screen.getByText(/删除失败:rm-fail/)).toBeTruthy())
    // prune 取消(255)
    confirmSpy.mockReturnValue(false)
    fireEvent.click(screen.getByText('清理'))
    expect(invoke).not.toHaveBeenCalledWith('docker_prune_images', expect.anything())
    // prune 失败(260)
    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByText('清理'))
    await waitFor(() => expect(screen.getByText(/清理失败:prune-fail/)).toBeTruthy())
    confirmSpy.mockRestore()
  })
})

describe('formatAge', () => {
  it('covers all relative-time branches', () => {
    const now = Date.now() / 1000
    expect(formatAge(now + 5)).toBe('刚刚')       // diff < 0
    expect(formatAge(now - 30)).toMatch(/分钟前/)  // minutes < 60
    expect(formatAge(now - 3600)).toMatch(/小时前/) // hours < 24
    expect(formatAge(now - 90000)).toMatch(/天前/)  // else days
  })
})
