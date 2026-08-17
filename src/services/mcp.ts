import { invoke } from '@tauri-apps/api/core'
import type { LlmJsonSchemaProperty, LlmTool, LlmToolCall } from '@/services/ai'
import type { McpServerConfig } from '@/stores/ai'

/** 工具调用等待确认时传给父组件的上下文(供弹窗渲染) */
export interface ToolConfirmCtx {
  toolName: string
  args: Record<string, unknown>
  reason: 'risk' | 'whitelist-miss' | 'always-confirm'
  message: string
}

/** confirmFn 签名: 异步等用户决策(弹窗/对话框),返回 true 批准 / false 拒绝 */
export type ToolConfirmFn = (ctx: ToolConfirmCtx) => Promise<boolean>

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface McpRuntime {
  tools: LlmTool[]
  warnings: string[]
  execute: (call: LlmToolCall) => Promise<string>
}

interface RegisteredMcpTool {
  server: McpServerConfig
  remoteName: string
}

function parseArguments(call: LlmToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.function.arguments || '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function functionSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || fallback
}

function functionName(server: McpServerConfig, remoteName: string): string {
  const serverPart = functionSegment(server.name, 'server').slice(0, 14)
  const toolPart = functionSegment(remoteName, 'tool')
  const prefix = `mcp__${serverPart}_${fnv1a(server.id).slice(0, 6)}__`
  return `${prefix}${toolPart.slice(0, Math.max(1, 64 - prefix.length))}`
}

function normalizeSchema(input: Record<string, unknown>): LlmTool['function']['parameters'] {
  const properties = input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)
    ? input.properties as Record<string, LlmJsonSchemaProperty>
    : {}
  return {
    ...input,
    type: 'object',
    properties,
    ...(Array.isArray(input.required)
      ? { required: input.required.filter((item): item is string => typeof item === 'string') }
      : {})
  }
}

export async function listMcpTools(server: McpServerConfig): Promise<McpToolDefinition[]> {
  return invoke('mcp_list_tools', { server })
}

export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return invoke('mcp_call_tool', { server, toolName, arguments: args })
}

/** MCP 调用结果 → 回给 LLM 的文本(内容数组拼接 + structuredContent + isError 标记)。 */
export function formatMcpResult(result: Record<string, unknown>): string {
  const parts: string[] = []
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item || typeof item !== 'object') continue
      const content = item as Record<string, unknown>
      if (content.type === 'text' && typeof content.text === 'string') {
        parts.push(content.text)
      } else if (content.type === 'resource' && content.resource && typeof content.resource === 'object') {
        parts.push(JSON.stringify(content.resource, null, 2))
      } else {
        parts.push(JSON.stringify(content, null, 2))
      }
    }
  }
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2))
  }
  const formatted = parts.filter(Boolean).join('\n\n') || JSON.stringify(result, null, 2)
  return result.isError === true ? `[MCP tool error]\n${formatted}` : formatted
}

export async function createMcpRuntime(
  servers: McpServerConfig[],
  confirm: ToolConfirmFn
): Promise<McpRuntime> {
  const enabled = servers.filter(server => server.enabled)
  const registered = new Map<string, RegisteredMcpTool>()
  const warnings: string[] = []
  const tools: LlmTool[] = []

  const discoveries = await Promise.allSettled(enabled.map(async server => ({
    server,
    tools: await listMcpTools(server)
  })))
  discoveries.forEach((discovery, index) => {
    if (discovery.status === 'rejected') {
      const server = enabled[index]
      warnings.push(`${server.name}: ${discovery.reason instanceof Error ? discovery.reason.message : String(discovery.reason)}`)
      return
    }
    for (const remote of discovery.value.tools) {
      let name = functionName(discovery.value.server, remote.name)
      if (registered.has(name)) name = `${name.slice(0, 57)}_${fnv1a(remote.name).slice(0, 6)}`
      registered.set(name, { server: discovery.value.server, remoteName: remote.name })
      tools.push({
        type: 'function',
        function: {
          name,
          description: `[MCP · ${discovery.value.server.name}] ${remote.description || remote.name}`,
          parameters: normalizeSchema(remote.inputSchema || {})
        }
      })
    }
  })

  return {
    tools,
    warnings,
    async execute(call: LlmToolCall): Promise<string> {
      const target = registered.get(call.function.name)
      if (!target) throw new Error(`MCP 工具未注册或已失效: ${call.function.name}`)
      const args = parseArguments(call)
      const approved = await confirm({
        toolName: call.function.name,
        args: { server: target.server.name, tool: target.remoteName, ...args },
        reason: 'always-confirm',
        message: `即将调用 MCP Server「${target.server.name}」的工具 ${target.remoteName}。\n\n参数:\n${JSON.stringify(args, null, 2)}\n\nMCP 工具可能访问外部系统或修改数据,请确认本次调用。`
      })
      if (!approved) throw new Error('[Rejected by user]')
      return formatMcpResult(await callMcpTool(target.server, target.remoteName, args))
    }
  }
}
