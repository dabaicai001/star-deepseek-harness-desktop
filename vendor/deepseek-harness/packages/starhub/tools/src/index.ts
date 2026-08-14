/**
 * StarHub 宿主工具桥(内核替换 P1-4,StarHub 本地包,不在上游)。把 StarHub 能力
 * 注册为 dsh 模型工具;工具体不在 dsh 进程内执行,而是经 SDK stdio JSON-RPC 的
 * 双向 request(方法 `starhub/tool.execute`,参数 `{ name, args }`,结果为
 * 模型可读文本)桥回 StarHub Rust 主进程执行(方案 4.1「工具执行回调」)。
 * 依赖同组合的 sdk-jsonrpc-server 插件提供的 `sdk-transport` 服务
 * (StarHub 对 sdk/server 的本地补丁);缺失时加载即失败(fail loud)。
 *
 * @module @deepseek-ai/dsh-starhub-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

export const name = 'starhub-tools'
export const inject = ['tools']

/** 桥方法名;Rust 侧实现见 src-tauri/src/harness/tools.rs。 */
const BRIDGE_METHOD = 'starhub/tool.execute'

/** 工具的规范输出:宿主返回的模型可读文本原样透传。 */
const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

/**
 * 发起一次宿主工具调用。
 * @param transport - sdk-jsonrpc-server 暴露的 stdio transport。
 * @param toolName - StarHub 工具名。
 * @param args - 经 schema 校验后的模型参数。
 * @returns 宿主返回的文本结果;桥错误(宿主报错/进程断开)抛为工具失败。
 */
async function callHost(transport: JsonRpcTransportPeer, toolName: string, args: object): Promise<{ text: string }> {
  const result = await transport.request(BRIDGE_METHOD, { name: toolName, args })
  if (typeof result !== 'string') {
    throw new Error(`starhub host returned a non-string result for ${toolName}`)
  }
  return { text: result }
}

/**
 * 注册第一批 StarHub 工具:starhub_list_capabilities / starhub_list_assets /
 * session_search / memory。工具描述与 schema 沿用旧前端实现(内核替换前
 * src/utils/aiTools.ts 与 AiView.vue 的 workspaceTools)。
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  // sdk-transport 是宿主私有服务名,不走 Context 接口声明合并,读取后窄化。
  const transport = ctx.get('sdk-transport') as JsonRpcTransportPeer | undefined
  if (!transport) {
    throw new Error('starhub-tools requires sdk-jsonrpc-server (sdk-transport service) in the same composition')
  }

  const renderText = (_args: never, value: { text: string }): { type: 'text'; text: string }[] => [
    { type: 'text', text: value.text },
  ]

  ctx.tools.register(defineTool({
    name: 'starhub_list_capabilities',
    description: '列出 StarHub 可以进入的模块和功能,用于规划跨模块任务。',
    parameters: {},
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderText,
    },
    async execute(args) {
      return callHost(transport, 'starhub_list_capabilities', args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'starhub_list_assets',
    description: '列出 StarHub 工作区资产(SSH / 数据库 / Docker / 本机 / Excel)。',
    parameters: {
      type: {
        type: 'string',
        enum: ['ssh', 'db', 'docker', 'local', 'excel'],
        description: '可选: ssh、db、docker、local 或 excel',
      },
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderText,
    },
    async execute(args) {
      return callHost(transport, 'starhub_list_assets', args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_search',
    description:
      '搜索 AI 助手的历史会话存档(FTS5 全文检索)。三种用法:1) 传 query 全文搜索所有历史会话,返回命中片段;'
      + '2) 传 conversation_id 浏览该会话消息;3) 传 conversation_id + before_rowid 向前翻页。',
    parameters: {
      query: { type: 'string', description: 'FTS5 搜索词,中文按字分词;多个词用空格(AND)或 OR 连接' },
      conversation_id: { type: 'string', description: '要浏览的会话 id(search 结果里返回)' },
      before_rowid: { type: 'number', description: '翻页:返回该 rowid 之前的消息' },
      limit: { type: 'number', description: '返回条数上限,默认 20' },
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderText,
    },
    async execute(args) {
      return callHost(transport, 'session_search', args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory',
    description:
      '管理长期记忆(跨会话持久)。三个动作:add 新增条目;replace 用 old_text 唯一子串定位并替换条目;'
      + 'remove 用 old_text 唯一子串删除条目。target:user=用户偏好与习惯;global=跨资产的通用环境事实与经验;'
      + 'asset=当前绑定资产的专属事实(如"这台是生产库,DDL 前必须备份")。记忆内容会在以后的会话开始时就出现在你的上下文里。'
      + '该存:用户偏好、环境事实(系统/端口/拓扑)、用户纠正、项目约定、已完成的重要工作;'
      + '不该存:琐碎信息、可重新查到的知识、原始数据(日志/大段代码)、会话临时状态、任何密码/密钥/令牌。',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'replace', 'remove'] },
      target: { type: 'string', required: true, enum: ['user', 'global', 'asset'] },
      content: { type: 'string', description: 'add/replace 的新条目内容,信息密度要高,可多条事实合并成一条' },
      old_text: { type: 'string', description: 'replace/remove 用:能唯一定位目标条目的短子串' },
    },
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: renderText,
    },
    async execute(args) {
      return callHost(transport, 'memory', args)
    },
  }))
}
