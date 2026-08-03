/**
 * Redis key 命名空间树:按 ':' 前缀把扁平 key 列表组织成 trie。
 * 排序:目录在前(keyCount 降序,平级再按名),叶子在后(按名)。
 * 纯函数,node --test 可测。
 */
export interface RedisKeyLike {
  key: string
  type: string
  ttl: number
}

export interface RedisTreeNode {
  name: string
  fullKey: string
  keyType: string
  ttl: number
  isLeaf: boolean
  keyCount: number
  children: RedisTreeNode[]
}

interface MutableTrieNode extends RedisTreeNode {
  childrenMap: Map<string, MutableTrieNode>
}

/** 目录在前(keyCount 降序,平级按名),叶子在后(按名) */
function compareNodes(a: RedisTreeNode, b: RedisTreeNode): number {
  if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1
  if (!a.isLeaf) return b.keyCount - a.keyCount || a.name.localeCompare(b.name)
  return a.name.localeCompare(b.name)
}

export function buildRedisNamespaceTree(keys: RedisKeyLike[]): RedisTreeNode[] {
  if (keys.length === 0) return []
  const root = new Map<string, MutableTrieNode>()

  for (const k of keys) {
    const parts = k.key.split(':')
    let level = root
    let path = ''
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]
      path = path ? `${path}:${seg}` : seg
      const isLast = i === parts.length - 1
      let node = level.get(seg)
      if (!node) {
        node = {
          name: seg,
          fullKey: path,
          keyType: isLast ? k.type : '',
          ttl: isLast ? k.ttl : 0,
          isLeaf: isLast,
          keyCount: 0,
          children: [],
          childrenMap: new Map()
        }
        level.set(seg, node)
      }
      if (isLast) {
        node.isLeaf = true
        node.keyType = k.type
        node.ttl = k.ttl
        node.fullKey = k.key
      }
      level = node.childrenMap
    }
  }

  function finalize(node: MutableTrieNode): number {
    // 先递归算出所有子级的 keyCount,再排序(排序依赖 keyCount)
    const children = [...node.childrenMap.values()]
    let sum = node.isLeaf ? 1 : 0
    for (const child of children) sum += finalize(child)
    node.keyCount = sum
    node.children = children.sort(compareNodes)
    return sum
  }

  const roots = [...root.values()].map(node => {
    finalize(node)
    return node as RedisTreeNode
  })
  return roots.sort(compareNodes)
}
