// @vitest-environment jsdom
/**
 * ui-deliverables browser half: the derivation contract of
 * `producedForClosing` over engine-published Turn data, the row's rendering
 * and opener wiring, and the plugin registrations' fiber-teardown removal
 * (HMR safety) against the real SlotRegistry.
 */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationEventRegistry, ConversationNodeAssembler, SlotRegistry,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationEventInput, ConversationLocationDataStore, ConversationMatch, ConversationNodeDefinition,
  ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewDefinition,
  ConversationViewNode, ToolResultNode, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { ChatFileMentions, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  fitProducedFiles, ProducedFiles, type ProducedFilesProps,
} from '../src/client/ProducedFiles.tsx'
import {
  basename, deliverablesDefinition, producedEntriesForClosing, producedFileMentions,
  producedForClosing, selectProducedFiles,
  type DeliverablesTurnData, type ProducedEntry,
} from '../src/client/turn-deliverables.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyInvariant } from '../src/invariant.ts'
import { en, zh } from '../src/client/locales.ts'

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalClientWidth === undefined) {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  } else {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  }
})

class TestTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

const turnLocation = (turn: number, deliverables?: DeliverablesTurnData): TurnLocation => {
  const data = new TestTurnDataStore()
  if (deliverables !== undefined) data.set('deliverables', deliverables)
  return { turn, start: undefined, end: undefined, status: 'closed', steps: [], data }
}

const produced = (
  ...values: ReadonlyArray<readonly [seq: number, path: string, over?: Partial<ProducedEntry>]>
): DeliverablesTurnData => ({
  produced: values.map(([seq, path, over]) => ({ seq, path, created: false, added: 0, removed: 0, ...over })),
})

/** One component-side produced entry (defaults: modified, no line estimate). */
const entryOf = (path: string, over?: Partial<ProducedEntry>): ProducedEntry => ({
  seq: 1, path, created: false, added: 0, removed: 0, ...over,
})

function tailOwner(
  data: DeliverablesTurnData | undefined,
  seq: number,
  openFile: (path: string) => void = () => {},
  turn = 1,
  viewFile?: TurnTailOwnerProps['viewFile'],
): TurnTailOwnerProps {
  return { seq, openFile, viewFile, turn: turnLocation(turn, data) }
}

interface TimelineSnapshot {
  readonly timeline: ConversationTimelineSnapshot
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [deliverablesDefinition] }
  fallbackEntry(): ConversationNodeDefinition | undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [timelineViewDefinition] }
}

const timelineViewDefinition: ConversationViewDefinition<ConversationViewNode, TimelineSnapshot> = {
  target: 'test',
  create: () => {
    let current: TimelineSnapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return {
      empty: current,
      replace: ({ timeline }) => (current = { timeline }),
      apply: ({ timeline }) => (current = { timeline }),
    }
  },
}

function at(
  seq: number,
  type: string,
  data: unknown,
  view?: ConversationEventInput['view'],
): ConversationEventInput {
  return {
    event: {
      seq, time: seq * 1_000, type, data,
      ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}),
    } as ConversationEventInput['event'],
    view,
  }
}

function matched(input: ConversationEventInput, role: ConversationMatch['role']): ConversationMatch {
  return { ...input, role, location: { kind: 'unresolved' } }
}

function call(
  seq: number,
  callId: string,
  view: ToolResultNode['callView'],
  turn = 1,
): ConversationEventInput {
  return at(
    seq,
    'tool/call',
    { turn, step: 1, callId, name: 'fixture', arguments: '{}' },
    { for: 'call', view: view ?? { card: 'generic', title: 'fixture' } },
  )
}

function result(seq: number, callId: string, isError = false, turn = 1): ConversationEventInput {
  return at(seq, 'tool/result', {
    turn,
    step: 1,
    message: {
      source: { type: 'tool-result', callId },
      content: [{ type: 'tool-result', content: [], isError }],
    },
  })
}

function diff(...paths: string[]): ToolResultNode['callView'] {
  return {
    card: 'diff', title: `Write ${paths[0] ?? ''}`,
    diffs: paths.map(path => ({ path, oldText: null, newText: 'x' })),
    locations: paths.map(path => ({ path })),
  }
}

function edit(path: string): ToolResultNode['callView'] {
  return { card: 'generic', title: `insert ${path}`, kind: 'edit', locations: [{ path }] }
}

function assembler(entries: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function deliverablesOf(value: ConversationNodeAssembler, turn = 1): Readonly<DeliverablesTurnData> | undefined {
  const snapshot = value.snapshot('test') as TimelineSnapshot
  return snapshot.timeline.turns.get(turn)?.data.get('deliverables')
}

describe('produced-file Turn data', () => {
  it('deduplicates paths in first-seen order and stops at the closing Assistant seq', () => {
    const data = produced(
      [3, 'out/index.html'],
      [4, 'out/app.css'],
      [4, 'out/index.html'],
      [8, 'after.txt'],
    )
    expect(producedForClosing(data, 6)).toEqual(['out/index.html', 'out/app.css'])
    expect(selectProducedFiles(tailOwner(data, 6))?.map(entry => entry.path))
      .toEqual(['out/index.html', 'out/app.css'])
    expect(producedForClosing(undefined)).toEqual([])
    expect(selectProducedFiles(tailOwner(undefined, 9, () => {}, 2))).toBeNull()
  })

  it('folds successful diff and generic-edit calls while ignoring reads, failures, and missing locations', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', diff('out/index.html', 'out/app.css')),
      result(3, 'write'),
      call(4, 'edit', edit('notes.md')),
      result(5, 'edit'),
      call(6, 'read', { card: 'generic', title: 'Read', locations: [{ path: 'input.txt' }] }),
      result(7, 'read'),
      call(8, 'failed', diff('broken.txt')),
      result(9, 'failed', true),
      call(10, 'locationless', { card: 'diff', title: 'Write', diffs: [] }),
      result(11, 'locationless'),
    ])

    expect(producedForClosing(deliverablesOf(value))).toEqual([
      'out/index.html', 'out/app.css', 'notes.md',
    ])
    // Diff cards derive the change shape from their own diffs: oldText null is a
    // create (removed 0), hunk texts estimate the +/- lines; the generic edit
    // shape carries no stats.
    expect(producedEntriesForClosing(deliverablesOf(value))).toEqual([
      { seq: 3, path: 'out/index.html', created: true, added: 1, removed: 0 },
      { seq: 3, path: 'out/app.css', created: true, added: 1, removed: 0 },
      { seq: 5, path: 'notes.md', created: false, added: 0, removed: 0 },
    ])
  })

  it('derives modification stats from an edit diff (oldText present)', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'edit', {
        card: 'diff', title: 'Edit src/a.ts',
        diffs: [{ path: 'src/a.ts', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' }],
        locations: [{ path: 'src/a.ts' }],
      }),
      result(3, 'edit'),
    ])
    expect(producedEntriesForClosing(deliverablesOf(value))).toEqual([
      { seq: 3, path: 'src/a.ts', created: false, added: 3, removed: 2 },
    ])
  })

  it('ignores calls without mutation locations, orphan results, and replacement results', () => {
    const replacement = result(8, 'replacement')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'no-view', name: 'fixture', arguments: '{}' }),
      result(3, 'no-view'),
      call(4, 'locationless-edit', { card: 'generic', title: 'Edit', kind: 'edit' }),
      result(5, 'locationless-edit'),
      result(6, 'orphan'),
      call(7, 'replacement', diff('replaced.txt')),
      {
        ...replacement,
        event: {
          ...replacement.event,
          surfaceOp: { op: 'replace', start: 1, end: 1 },
        } as ConversationEventInput['event'],
      },
      at(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    expect(producedForClosing(deliverablesOf(value))).toEqual([])
  })

  it('rejects an invalid start match and preserves state for an unrelated update', () => {
    const startMatch = matched(at(1, 'turn/start', { turn: 1 }), 'start')
    const emptyContext: Parameters<typeof deliverablesDefinition.start>[0] = {
      key: 'deliverables:1',
      kind: 'deliverables',
      id: '1',
      matches: [startMatch],
      start: startMatch,
      state: undefined,
      current: new Map(),
    }
    const reader: Parameters<typeof deliverablesDefinition.start>[2] = { previous: () => undefined }
    const state = deliverablesDefinition.start(emptyContext, startMatch, reader)
    const unrelated = matched(at(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'update')
    const context: Parameters<typeof deliverablesDefinition.update>[0] = { ...emptyContext, state }

    expect(() => deliverablesDefinition.start(emptyContext, unrelated, reader))
      .toThrow('deliverables start requires turn/start')
    expect(deliverablesDefinition.update(context, unrelated)).toBe(state)
  })

  it('replays a tail page once prepend supplies its missing Turn start', () => {
    const value = assembler([
      call(10, 'late', diff('history.txt')),
      result(11, 'late'),
    ], true)
    expect(deliverablesOf(value)).toBeUndefined()

    value.prepend([at(1, 'turn/start', { turn: 1 })], false)
    value.flush()
    expect(producedForClosing(deliverablesOf(value))).toEqual(['history.txt'])
  })

  it('extends the same Turn data incrementally on live append', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'first', diff('first.txt')),
      result(3, 'first'),
    ])
    const first = deliverablesOf(value)
    expect(producedForClosing(first)).toEqual(['first.txt'])

    value.append(call(4, 'second', diff('second.txt')))
    value.append(result(5, 'second'))
    value.flush()
    expect(producedForClosing(deliverablesOf(value))).toEqual(['first.txt', 'second.txt'])
  })
})

describe('ProducedFiles row', () => {
  const t = makeTranslate(zh)
  const capability = (
    canOpenPath: boolean | undefined,
    isLoopback = true,
  ): Pick<ProducedFilesProps, 'isLoopback' | 'useHostDescription'> => {
    const description = canOpenPath === undefined
      ? undefined
      : { version: 'test', cwd: '/workspace', attachedSessions: 1, canOpenPath }
    return {
      isLoopback,
      useHostDescription: selector => selector(description),
    }
  }

  it('selects the largest prefix using the exact remainder width', () => {
    expect(fitProducedFiles(230, 8, [70, 60, 60], [55, 55, 55, 55])).toBe(2)
    expect(fitProducedFiles(145, 8, [70, 60, 60], [55, 55, 55, 55])).toBe(1)
    expect(fitProducedFiles(300, 8, [70, 60, 60], [55, 55, 55, 55])).toBe(3)
    // A zero-width lane is a pre-layout test/hidden state, not evidence that
    // every chip overflowed; keep the bounded initial prefix until measured.
    expect(fitProducedFiles(0, 8, [70, 60], [60, 50, undefined])).toBe(2)
    expect(fitProducedFiles(128, 8, [60, 60], [70, 50, undefined])).toBe(2)
    // Candidate-specific suffix widths matter at the 10 -> 9 digit boundary.
    expect(fitProducedFiles(126, 8, [60], [70, 50])).toBe(1)
    expect(fitProducedFiles(20, 8, [60], [70, 50])).toBe(0)
  })

  it('keeps one measured line, updates on resize, and opens a file or the workspace folder', () => {
    const entries = ['deep/a.html', 'b.css', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
      .map(path => entryOf(path))
    const openFile = vi.fn<(path: string) => void>()
    let available = 226
    let resize: ResizeObserverCallback | undefined
    const disconnect = vi.fn()
    const observeNode = vi.fn<(target: Element) => void>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe(target: Element): void {
        expect(target).toBeInstanceOf(Element)
        observeNode(target)
      }
      disconnect(): void { disconnect() }
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-produced-files-row') ? available : 0 },
    })
    const rect = (width: number): DOMRect => ({
      x: 0, y: 0, width, height: 22, top: 0, right: width, bottom: 22, left: 0,
      toJSON: () => ({}),
    })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getProbeRect(this: HTMLElement) {
        if (this.closest('[aria-hidden="true"]') === null) return rect(0)
        if (this.tagName !== 'BUTTON') return rect(60)
        if (this.textContent === 'a.html' || this.textContent === 'b.css') return rect(50)
        // The remainder probe is a button now (it expands the full list).
        if (this.textContent !== null && this.textContent.includes('个文件')) return rect(60)
        return rect(100)
      })

    const view = render(
      <ProducedFiles matched={entries} openFile={openFile} {...capability(true)} t={t} />,
    )
    expect(view.getByText('产物')).toBeTruthy()
    const row = view.container.querySelector('[data-produced-files-row]')
    if (!(row instanceof HTMLElement)) throw new Error('produced row missing')
    // The third probe is 100px: two chips plus the remainder fit, three do not;
    // the remainder itself is a button that expands the full list.
    expect(within(row).getAllByRole('button')).toHaveLength(3)
    expect(within(row).getByText('+ 5 个文件')).toBeTruthy()
    const chip = view.getByRole('button', { name: '打开 deep/a.html' })
    expect(chip.textContent).toBe('a.html')
    expect(chip.getAttribute('title')).toBe('deep/a.html')
    expect(view.queryByRole('button', { name: '打开 g.ts' })).toBeNull()
    fireEvent.click(chip)
    expect(openFile).toHaveBeenCalledWith('deep/a.html')

    const showFolder = view.getByRole('button', { name: '在文件夹中显示' })
    fireEvent.click(showFolder)
    expect(openFile).toHaveBeenLastCalledWith('.')

    available = 150
    act(() => { resize?.([], {} as ResizeObserver) })
    expect(within(row).getAllByRole('button')).toHaveLength(2)
    expect(within(row).getByText('+ 6 个文件')).toBeTruthy()

    // A missing/unsupported computed gap falls back to zero rather than NaN:
    // two 50px chips plus the remainder fit 165px, the next 100px chip does not.
    vi.stubGlobal('getComputedStyle', () => ({ columnGap: '', gap: '' } as CSSStyleDeclaration))
    available = 165
    act(() => { resize?.([], {} as ResizeObserver) })
    expect(within(row).getAllByRole('button')).toHaveLength(3)

    // Ref callbacks leave nulls in the probe arrays when the candidate set
    // shrinks; the replacement observer must skip those stale slots.
    observeNode.mockClear()
    view.rerender(
      <ProducedFiles matched={entries.slice(0, 1)} openFile={openFile} {...capability(true)} t={t} />,
    )
    expect(within(row).getAllByRole('button')).toHaveLength(1)
    expect(observeNode).toHaveBeenCalledTimes(3)

    view.unmount()
    expect(disconnect).toHaveBeenCalledTimes(2)
    bounds.mockRestore()
  })

  it('expands the remainder into the full changed-files list with tags and stats', () => {
    const entries = [
      entryOf('src/new-page.tsx', { created: true, added: 120 }),
      entryOf('src/api.ts', { added: 8, removed: 2 }),
      entryOf('src/util.ts'), entryOf('src/a.ts'), entryOf('src/b.ts'),
      entryOf('src/c.ts'), entryOf('src/d.ts'),
    ]
    const openFile = vi.fn<(path: string) => void>()
    const viewFile = vi.fn<NonNullable<ProducedFilesProps['viewFile']>>()
    vi.stubGlobal('ResizeObserver', undefined)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('data-produced-files-row') ? 100 : 0 },
    })
    const rect = (width: number): DOMRect => ({
      x: 0, y: 0, width, height: 22, top: 0, right: width, bottom: 22, left: 0,
      toJSON: () => ({}),
    })
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getProbeRect(this: HTMLElement) {
        if (this.closest('[aria-hidden="true"]') === null) return rect(0)
        // Chip probes are wide enough that none fit; the remainder fits alone.
        return rect(this.textContent !== null && this.textContent.includes('个文件') ? 60 : 150)
      })

    const view = render(
      <ProducedFiles
        matched={entries}
        openFile={openFile}
        viewFile={viewFile}
        {...capability(false)}
        t={t}
      />,
    )
    const more = view.getByRole('button', { name: '+ 7 个文件' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('本轮改动文件(共 7 个)')).toBeNull()

    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText('本轮改动文件(共 7 个)')).toBeTruthy()
    // Every file is listed — shown chips and hidden remainder alike — with its
    // change-shape tag and the diff +/- estimate (scoped to the list: the
    // hidden width probes render the same chip content).
    const list = view.container.querySelector('[data-produced-files-list]')
    if (!(list instanceof HTMLElement)) throw new Error('produced list missing')
    const listRows = within(list).getAllByRole('button', { name: /^打开 / })
    expect(listRows).toHaveLength(7)
    expect(within(list).getByText('新增')).toBeTruthy()
    expect(within(list).getAllByText('修改')).toHaveLength(6)
    expect(within(list).getByText('+120')).toBeTruthy()
    expect(within(list).getByText('+8')).toBeTruthy()
    expect(within(list).getByText('-2')).toBeTruthy()
    // List rows open through the same viewer-first opener as the chips.
    fireEvent.click(view.getByRole('button', { name: '打开 src/api.ts' }))
    expect(viewFile).toHaveBeenCalledWith({ kind: 'read', path: 'src/api.ts' })
    expect(openFile).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: '收起' }))
    expect(view.queryByText('本轮改动文件(共 7 个)')).toBeNull()
    bounds.mockRestore()
  })

  it('prefers the in-app viewer for chip clicks when viewFile is available', () => {
    const openFile = vi.fn<(path: string) => void>()
    const viewFile = vi.fn<NonNullable<ProducedFilesProps['viewFile']>>()
    const view = render(
      <ProducedFiles
        matched={[entryOf('deep/a.html')]}
        openFile={openFile}
        viewFile={viewFile}
        {...capability(true)}
        t={t}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: '打开 deep/a.html' }))
    expect(viewFile).toHaveBeenCalledWith({ kind: 'read', path: 'deep/a.html' })
    expect(openFile).not.toHaveBeenCalled()
  })

  it('keeps the folder action absent without overflow or a local native opener', () => {
    const openFile = vi.fn<(path: string) => void>()
    const view = render(
      <ProducedFiles matched={[entryOf('a.md')]} openFile={openFile} {...capability(true)} t={t} />,
    )
    const overflowing = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md']
      .map(path => entryOf(path))
    expect(view.queryByRole('button', { name: '在文件夹中显示' })).toBeNull()
    for (const unavailable of [capability(false), capability(true, false), capability(undefined)]) {
      view.rerender(<ProducedFiles matched={overflowing} openFile={openFile} {...unavailable} t={t} />)
      expect(view.queryByRole('button', { name: '在文件夹中显示' })).toBeNull()
    }
  })

  it('uses singular English copy when exactly one file is hidden', () => {
    const view = render(
      <ProducedFiles
        matched={['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md'].map(path => entryOf(path))}
        openFile={() => {}}
        {...capability(false)}
        t={makeTranslate(en)}
      />,
    )
    const row = view.container.querySelector('[data-produced-files-row]')
    if (!(row instanceof HTMLElement)) throw new Error('produced row missing')
    expect(within(row).getByText('+ 1 file')).toBeTruthy()
  })
})

describe('producedFileMentions resolver', () => {
  const label = (path: string) => `打开 ${path}`

  it('resolves exact paths and unique basenames; ambiguity and unknowns stay unresolved', () => {
    const opened: string[] = []
    const resolver = producedFileMentions(
      ['out/index.html', 'a/style.css', 'b/style.css'],
      (path) => { opened.push(path) },
      label,
    )
    // Unique basename resolves to its full path; the full path rides title.
    const byBasename = resolver.resolve('index.html')
    expect(byBasename?.label).toBe('打开 out/index.html')
    expect(byBasename?.title).toBe('out/index.html')
    byBasename?.open()
    expect(opened).toEqual(['out/index.html'])
    // An exact path resolves even when its basename is ambiguous.
    const exact = resolver.resolve('a/style.css')
    expect(exact?.title).toBe('a/style.css')
    // A basename two paths share stays unresolved rather than guessing,
    // and so does a token naming nothing the turn wrote.
    expect(resolver.resolve('style.css')).toBeUndefined()
    expect(resolver.resolve('notes.md')).toBeUndefined()
    expect(basename('a\\b\\c.txt')).toBe('c.txt')
  })
})

describe('package shells', () => {
  it('the invariant companion registers ownership', async () => {
    const registered: string[] = []
    const ctx = new Context()
    ctx.provide('invariants')
    ctx.set('invariants', {
      register: (pkg: string) => { registered.push(pkg); return () => {} },
    } as never)
    const dispose = await applyInvariant(ctx)
    expect(registered).toEqual(['@deepseek-ai/dsh-client-ui-deliverables'])
    expect(dispose).toBeTypeOf('function')
  })
})

describe('plugin registration', () => {
  it('registers the tail entry and fiber disposal removes it', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin(ConversationEventRegistry).await()
    // The owning view's child declaration, stood up by a bench root entry.
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.turnTail': { kind: 'chain', scope: 'session' } },
    } as never, () => null)
    const hostDescription = { getSnapshot: () => undefined, subscribe: () => () => {} }
    ctx.provide('connection', {
      api: { settings: {} },
      isLoopback: false,
      hostDescription,
    } as never)
    // ui-theme's Appearance row binds a durable scope through these two.
    ctx.provide('remote', { $on: () => () => {} } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [entry] = ctx.slots.entries('conversation.chat.turnTail')
    expect(entry).toBeDefined()
    expect(entry?.inject?.()).toEqual({ isLoopback: false, hooks: { hostDescription } })

    // The prose face is live while the plugin is: a produced turn yields a
    // resolver whose matches open through the owner-supplied opener.
    const opened: string[] = []
    const owner = tailOwner(
      produced([2, 'site/report.html']),
      3,
      (path) => { opened.push(path) },
    )
    const service = (ctx as unknown as { get(name: string): ChatFileMentions | undefined }).get('chatFileMentions')
    const mentions = service?.forClosing(owner)
    mentions?.resolve('report.html')?.open()
    expect(opened).toEqual(['site/report.html'])
    // An owner carrying the chat view's viewFile (StarHub in-app viewer) routes
    // mention opens through it instead of the OS opener.
    const viewed: unknown[] = []
    const viewerOwner = tailOwner(
      produced([2, 'site/report.html']),
      3,
      (path) => { opened.push(path) },
      1,
      (request) => { viewed.push(request) },
    )
    service?.forClosing(viewerOwner)?.resolve('report.html')?.open()
    expect(viewed).toEqual([{ kind: 'read', path: 'site/report.html' }])
    expect(opened).toEqual(['site/report.html'])
    // A turn that produced nothing yields no vocabulary at all.
    expect(service?.forClosing(tailOwner(undefined, 2))).toBeUndefined()

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    // Fiber teardown retracts the service: the consumer's ctx.get sees the off state.
    expect((ctx as unknown as { get(name: string): unknown }).get('chatFileMentions')).toBeUndefined()
  })
})
