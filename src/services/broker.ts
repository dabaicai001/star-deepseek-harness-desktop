import { invoke } from '@tauri-apps/api/core'
import type { TestResult } from '@/types/db'

export type BrokerKind = 'kafka' | 'nsq'

export interface BrokerConnectParams {
  host: string
  port: number
  username?: string
  password?: string
  ssl?: boolean
}

export interface BrokerResource {
  name: string
  partitions?: number
  channels?: number
  depth?: number
  messages?: number
  leader?: string
}

export interface BrokerOverview {
  kind: BrokerKind
  status: string
  endpoint: string
  nodeCount: number
  resources: BrokerResource[]
  observedAt: number
}

export function testBroker(kind: BrokerKind, params: BrokerConnectParams): Promise<TestResult> {
  return invoke('broker_test', { kind, params })
}

export function loadBrokerOverview(
  kind: BrokerKind,
  params: BrokerConnectParams,
): Promise<BrokerOverview> {
  return invoke('broker_overview', { kind, params })
}
