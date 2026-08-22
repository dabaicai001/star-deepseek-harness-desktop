/**
 * Turn-scoped produced-file Definition and readers. Client-only and
 * model-free: the vocabulary is the mutation tools' own follow-along
 * `locations`, never the closing prose.
 */
import type {
  ConversationNodeDefinition, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-client-runtime/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** One produced file: path plus the change shape the call's diff declared. */
export interface ProducedEntry {
  readonly seq: number
  readonly path: string
  /** True when the call created or overwrote the file (diff `oldText` is null). */
  readonly created: boolean
  /** Estimated added lines (the call diff's `newText` line count; 0 when unknown). */
  readonly added: number
  /** Estimated removed lines (the call diff's `oldText` line count; 0 for creates/unknown). */
  readonly removed: number
}

/** Immutable produced-file facts published against one Turn. */
export interface DeliverablesTurnData {
  readonly produced: readonly ProducedEntry[]
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    /** Successful mutation paths accumulated in this Turn. */
    deliverables: DeliverablesTurnData
  }
}

interface DeliverablesState extends DeliverablesTurnData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, ToolResultNode['callView']>
}

/** Line count of one diff text (empty text is zero lines, not one). */
function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

/**
 * Paths a call view reports having created or changed, by render intent rather
 * than tool name: a diff card, or a generic card whose kind is `edit` (the
 * shape `str_replace_editor`'s insert presents). Every other card produces
 * nothing to open — a read looked, a delete removed, a terminal ran. Only
 * root call views enter this Turn accumulator; nested Code Mode dispatches
 * preserve the pre-assembly behavior and do not contribute independently.
 *
 * A diff card's own `diffs` carry the per-file change shape (`oldText: null`
 * marks a create/overwrite, and the hunk texts estimate the +/- line counts);
 * its `locations` remain the fallback when a presenter omitted diffs.
 */
function producedPaths(view: ToolResultNode['callView']): readonly Omit<ProducedEntry, 'seq'>[] {
  if (view === null) return []
  if (view.card === 'diff') {
    if (view.diffs.length > 0) {
      return view.diffs.map(diff => ({
        path: diff.path,
        created: diff.oldText === null,
        added: lineCount(diff.newText),
        removed: diff.oldText === null ? 0 : lineCount(diff.oldText),
      }))
    }
    return (view.locations ?? []).map(location => ({ path: location.path, created: false, added: 0, removed: 0 }))
  }
  if (view.card === 'generic' && view.kind === 'edit') {
    return (view.locations ?? []).map(location => ({ path: location.path, created: false, added: 0, removed: 0 }))
  }
  return []
}

/**
 * Files produced by one Turn data value.
 *
 * The source is the mutation tools' own follow-along `locations`, not the
 * closing prose: a produced file must be listed whether or not the model
 * remembered to name it. A mutation is recognized by render intent, not by
 * tool name — a diff card, or a generic card whose `kind` is `edit` (the shape
 * `str_replace_editor`'s insert presents) — so a new mutation tool joins by
 * declaring what it does. Reads contribute nothing (looking at a file does not
 * produce it), and neither do deletes (there is nothing left to open) or
 * failed calls. Paths keep first-seen order and appear once, so a file written
 * and then edited in the same turn is one entry.
 *
 * The Conversation Location index owns turn membership before this function
 * runs, so paths cannot spill across turns and this derivation does not infer
 * boundaries from neighboring presentation Nodes.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced entries in first-seen order; empty when the turn wrote nothing.
 */
export function producedEntriesForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly ProducedEntry[] {
  if (data === undefined) return []
  const entries: ProducedEntry[] = []
  const seen = new Set<string>()
  for (const produced of data.produced) {
    if (produced.seq > seq || seen.has(produced.path)) continue
    seen.add(produced.path)
    entries.push(produced)
  }
  return entries
}

/**
 * Files produced by one Turn data value, paths only.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced paths in first-seen order; empty when the turn wrote nothing.
 */
export function producedForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly string[] {
  return producedEntriesForClosing(data, seq).map(entry => entry.path)
}

/**
 * Claim the turn-tail chain only when its closing turn produced files.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns Produced entries as the component's match, or null to decline before mount.
 */
export function selectProducedFiles(owner: TurnTailOwnerProps): readonly ProducedEntry[] | null {
  const entries = producedEntriesForClosing(owner.turn.data.get('deliverables'), owner.seq)
  return entries.length === 0 ? null : entries
}

/** Turn-local successful mutation accumulator; it publishes no view Node. */
export const deliverablesDefinition: ConversationNodeDefinition<DeliverablesState> = {
  kind: 'deliverables',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('deliverables start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), produced: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(
        String(match.event.data.callId),
        match.view?.for === 'call' ? match.view.view : null,
      )
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    const result = match.event.data.message.content[0]
    if (result.isError === true) return context.state
    const callId = String(match.event.data.message.source.callId)
    const additions = producedPaths(context.state.calls.get(callId) ?? null)
      .map(entry => ({ ...entry, seq: match.event.seq }))
    return additions.length === 0
      ? context.state
      : { ...context.state, produced: [...context.state.produced, ...additions] }
  },
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined
    ? null
    : {
      kind: 'turn',
      turn: context.state.turn,
      key: 'deliverables',
      value: { produced: context.state.produced },
    },
}

/**
 * Trailing path segment, the part that identifies the file at a glance.
 * @param path - Slash- or backslash-separated path.
 * @returns The final segment, or the whole string when separator-free.
 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * File-mention vocabulary over one turn's produced paths, for the closing
 * message's prose: an inline-code token opens the file it names. A token
 * resolves by exact path, or by being exactly the basename of exactly one
 * produced path — a basename two paths share stays inert rather than
 * guessing, so a mention link can never open the wrong file or 404.
 * @param paths - The turn's produced paths (tool order, already deduped).
 * @param openFile - The chat view's file opener.
 * @param label - Localizes the accessible open-label for a resolved path.
 * @returns The resolver MarkdownText consumes; the full path rides `title`,
 * the same disambiguator the row's chips carry.
 */
export function producedFileMentions(
  paths: readonly string[],
  openFile: (path: string) => void,
  label: (path: string) => string,
): MarkdownFileMentions {
  return {
    resolve(value) {
      const path = paths.includes(value) ? value : onlyPathWithBasename(paths, value)
      if (path === undefined) return undefined
      return { open: () => { openFile(path) }, label: label(path), title: path }
    },
  }
}

/** The single produced path whose basename is exactly `value`, else undefined. */
function onlyPathWithBasename(paths: readonly string[], value: string): string | undefined {
  const matches = paths.filter(path => basename(path) === value)
  return matches.length === 1 ? matches[0] : undefined
}
