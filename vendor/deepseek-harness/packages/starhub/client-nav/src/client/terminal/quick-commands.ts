import { decodeQblText, parseXshellQblDetailed, parseXshellQblx, type XshellQuickCommand } from './xshell-quick-command.ts'

const STORAGE_KEY = 'starhub:ssh:quick-commands'

export interface QuickCommand extends XshellQuickCommand {
  id: string
}

function createId(): string {
  return `quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function loadQuickCommands(): QuickCommand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is QuickCommand => (
      typeof entry === 'object' && entry !== null
      && typeof (entry as QuickCommand).id === 'string'
      && typeof (entry as QuickCommand).label === 'string'
      && typeof (entry as QuickCommand).cmd === 'string'
    ))
  } catch {
    return []
  }
}

export function saveQuickCommands(commands: QuickCommand[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(commands))
}

export async function importQuickCommands(file: File): Promise<{ commands: QuickCommand[]; skippedScripts: number }> {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.qblx')) {
    const result = await parseXshellQblx(await file.arrayBuffer())
    return { commands: result.commands.map((command) => ({ ...command, id: createId() })), skippedScripts: result.skippedScripts }
  }
  if (lowerName.endsWith('.qbl')) {
    const result = parseXshellQblDetailed(decodeQblText(await file.arrayBuffer()))
    return { commands: result.commands.map((command) => ({ ...command, id: createId() })), skippedScripts: result.skippedScripts }
  }
  throw new Error('请选择 Xshell .qbl 或 .qblx 文件')
}

export function createQuickCommand(label = '', cmd = ''): QuickCommand {
  return { id: createId(), label, cmd }
}
