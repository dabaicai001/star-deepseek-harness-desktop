/**
 * Docker 连接参数构建:DockerView 与 objectTree(资产树展开)共用,
 * 避免两处各自拼装 socket/tcp/ssh 三种 transport 的参数。
 */
import { invoke } from '@tauri-apps/api/core'
import type { Asset } from '@/types/asset'
import type { DockerConnectParams } from '@/types/docker'

/**
 * 按资产配置构建 Docker 连接参数。
 * transport 优先级:config.dockerTransport → 有 remoteHost 走 tcp → 默认本地 socket。
 * ssh transport 需要所选 SSH 资产已信任主机密钥(含跳板机),否则抛错引导用户先开 SSH 连接。
 */
export async function buildDockerConnectParams(asset: Asset, sshAsset: Asset | null): Promise<DockerConnectParams> {
  const config = asset.config
  const transport = config.dockerTransport || (config.remoteHost ? 'tcp' : 'socket')
  if (transport === 'ssh') {
    if (!sshAsset?.config.host || !sshAsset.config.username) {
      throw new Error('所选 SSH 资产不存在或配置不完整')
    }
    const sshPort = sshAsset.config.port || 22
    const knownHostKey = await invoke<string | null>('ssh_get_trusted_host_key', {
      host: sshAsset.config.host,
      port: sshPort,
    })
    if (!knownHostKey) {
      throw new Error(`尚未信任 ${sshAsset.config.host}:${sshPort}，请先打开该 SSH 连接并确认主机密钥`)
    }
    let jumpKnownHostKey: string | undefined
    if (sshAsset.config.jumpHost) {
      jumpKnownHostKey = await invoke<string | null>('ssh_get_trusted_host_key', {
        host: sshAsset.config.jumpHost,
        port: sshAsset.config.jumpPort || 22,
      }) || undefined
      if (!jumpKnownHostKey) {
        throw new Error(`尚未信任跳板机 ${sshAsset.config.jumpHost}:${sshAsset.config.jumpPort || 22}`)
      }
    }
    return {
      transport: 'ssh',
      socketPath: config.socketPath || '/var/run/docker.sock',
      ssh: {
        host: sshAsset.config.host,
        port: sshPort,
        username: sshAsset.config.username,
        password: sshAsset.config.password,
        privateKey: sshAsset.config.privateKey,
        passphrase: sshAsset.config.passphrase,
        knownHostKey,
        jumpHost: sshAsset.config.jumpHost,
        jumpPort: sshAsset.config.jumpPort,
        jumpUsername: sshAsset.config.jumpUsername,
        jumpPassword: sshAsset.config.jumpPassword,
        jumpPrivateKey: sshAsset.config.jumpPrivateKey,
        jumpPassphrase: sshAsset.config.jumpPassphrase,
        jumpKnownHostKey,
        protocol: config.dockerSshProtocol || 'unix-over-nc-sudo',
      },
    }
  }
  if (transport === 'tcp') {
    return { transport: 'tcp', host: config.remoteHost || 'tcp://127.0.0.1:2375' }
  }
  const socketPath = config.socketPath || '/var/run/docker.sock'
  return {
    transport: 'socket',
    host: socketPath.includes('://') ? socketPath : `unix://${socketPath}`,
  }
}
