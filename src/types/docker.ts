export interface DockerConnectionInfo {
  connId: string
  host: string
}

export interface DockerConnectParams {
  host?: string
  apiVersion?: string
}

export interface TestResult {
  ok: boolean
  message: string
  elapsed_ms?: number
}

export interface PortInfo {
  private: number
  public?: number
  type: string
}

export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
  created: number
  ports: PortInfo[]
  labels: Record<string, string>
}

export interface ImageInfo {
  id: string
  tags: string[]
  size: number
  created: number
  digest?: string
}

export interface ContainerStats {
  cpuPercent: number
  memoryUsage: number
  memoryLimit: number
  memoryPercent: number
  netRx: number
  netTx: number
  blockRead: number
  blockWrite: number
  pids: number
}

export interface LogEntry {
  timestamp: string
  stream: string
  message: string
}

export interface DockerSession {
  connId: string
  host: string
  connected: boolean
  name: string
  assetId: string
}
