/**
 * 记忆写入安全扫描(记忆系统二期,L1 热记忆)。
 *
 * 记忆内容会注入 system prompt,且运维对话天然含敏感信息,写入前必须拦截:
 *  1) 隐形 Unicode(零宽字符、双向控制、TAG 块)——可用于藏注入指令
 *  2) prompt 注入模式(伪造 system 指令、角色覆写)
 *  3) 凭据字面量(私钥、password/api_key/secret/token 赋值)
 *
 * 命中即拒收,调用方把 reason 原样回给 LLM(软错误,可纠正后重试)。
 */

export interface MemoryScanResult {
  ok: boolean
  reason?: string
}

/** 零宽字符 U+200B-U+200F、双向控制 U+202A-U+202E、U+2060-U+2064、BOM U+FEFF、TAG 块 U+E0000-U+E007F */
const INVISIBLE_UNICODE = /[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{feff}\u{e0000}-\u{e007f}]/u

/** prompt 注入模式(不区分大小写) */
const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore\s+(?:(?:all|previous|above)\s+)+instructions/i, label: '忽略指令注入' },
  { re: /system\s*prompt/i, label: '提及 system prompt' },
  { re: /you\s+are\s+now\b/i, label: '角色覆写' },
  { re: /\bdisregard\b/i, label: '忽略指令注入' },
  { re: /^\s*system\s*:/im, label: '伪造 system 角色行' },
  { re: /<\/?\s*system\s*>/i, label: '伪造 system 标签' }
]

/** 私钥块头 */
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/**
 * 凭据赋值字面量:password/api_key/secret/token + :或= + 值。
 * 值必须是非空白、非引号的连续串且长度 ≥ 4,避免误伤正常句子
 * (如 "token 过期了" / "password is required")。
 */
const CREDENTIAL = /(?:password|api[_-]?key|secret|token)\s*[:=]\s*[^\s'"]{4,}/i

export function scanMemoryContent(content: string): MemoryScanResult {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: '内容为空' }
  }
  if (INVISIBLE_UNICODE.test(content)) {
    return { ok: false, reason: '包含隐形 Unicode 字符(零宽/控制字符),可能被用于隐藏注入指令' }
  }
  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(content)) {
      return { ok: false, reason: `命中 prompt 注入模式(${label})` }
    }
  }
  if (PRIVATE_KEY.test(content)) {
    return { ok: false, reason: '包含私钥字面量(-----BEGIN ... PRIVATE KEY-----),凭据禁止写入记忆' }
  }
  if (CREDENTIAL.test(content)) {
    return { ok: false, reason: '包含疑似凭据赋值(password/api_key/secret/token = 值),凭据禁止写入记忆' }
  }
  return { ok: true }
}
