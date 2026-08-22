/** `deliverables` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deliverables'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'produced.label': '产物',
  'produced.moreOne': '+ 1 个文件',
  'produced.more': '+ {count} 个文件',
  'produced.open': '打开 {name}',
  'produced.showInFolder': '在文件夹中显示',
  'produced.expand': '展开全部 {count} 个文件',
  'produced.collapse': '收起',
  'produced.listTitle': '本轮改动文件(共 {count} 个)',
  'produced.created': '新增',
  'produced.modified': '修改',
}

/** English dictionary (same key set). */
export const en: Record<DeliverablesKey, string> = {
  'produced.label': 'Produced',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
  'produced.showInFolder': 'Show in folder',
  'produced.expand': 'Show all {count} files',
  'produced.collapse': 'Collapse',
  'produced.listTitle': 'Files changed this turn ({count})',
  'produced.created': 'New',
  'produced.modified': 'Modified',
}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof zh
