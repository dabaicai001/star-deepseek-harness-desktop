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
  'produced.expand': '查看全部 {count} 个文件',
  'produced.drawerTitle': '本轮改动文件(共 {count} 个)',
  'produced.drawerClose': '关闭',
  'produced.createdSection': '新增({count})',
  'produced.modifiedSection': '修改({count})',
}

/** English dictionary (same key set). */
export const en: Record<DeliverablesKey, string> = {
  'produced.label': 'Produced',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
  'produced.showInFolder': 'Show in folder',
  'produced.expand': 'Show all {count} files',
  'produced.drawerTitle': 'Files changed this turn ({count})',
  'produced.drawerClose': 'Close',
  'produced.createdSection': 'New ({count})',
  'produced.modifiedSection': 'Modified ({count})',
}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof zh
