import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

/**
 * 5 档断点名称(由小到大)
 */
export type BreakpointName = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/**
 * 断点边界表(像素)。与 `src/styles/cyber.css` 的 `--bp-*` token 同步维护:
 * - xs: ≤ 1024px(窄屏,典型 13" 笔记本)
 * - sm: 1025-1280px(标准,14" 笔记本)
 * - md: 1281-1600px(设计基线,15-16" 笔记本 / 1080p)
 * - lg: 1601-1920px(宽屏,24" 显示器)
 * - xl: ≥ 1921px(超大屏,4K)
 */
const BP_TABLE: ReadonlyArray<{ name: BreakpointName; minWidth: number }> = [
  { name: 'xs', minWidth: 0 },
  { name: 'sm', minWidth: 1025 },
  { name: 'md', minWidth: 1281 },
  { name: 'lg', minWidth: 1601 },
  { name: 'xl', minWidth: 1921 },
]

/**
 * 把当前窗口宽度解析到 5 档断点之一(命中最大 minWidth)
 */
export function resolveBreakpoint(width: number): BreakpointName {
  for (let i = BP_TABLE.length - 1; i >= 0; i--) {
    if (width >= BP_TABLE[i]!.minWidth) return BP_TABLE[i]!.name
  }
  return 'xs'
}

function readViewport(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 }
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * 响应式断点 composable
 *
 * 特性:
 * - 200ms resize 节流(避免拖动窗口时高频触发响应式逻辑)
 * - SSR 安全(无 window 时返回 0/0)
 * - 组件卸载时清理 timer + listener,不泄漏
 * - 返回 ref + computed,模板里直接 `bp.name.value === 'xs'` 使用
 *
 * 用法:
 * ```ts
 * const bp = useBreakpoint()
 * watch(() => bp.name.value, (n) => { ... })
 *
 * // 模板:
 * <div v-if="bp.isNarrow">窄屏布局</div>
 * ```
 */
export function useBreakpoint() {
  const initial = readViewport()
  const width = ref(initial.width)
  const height = ref(initial.height)
  const name = ref<BreakpointName>(resolveBreakpoint(initial.width))

  let resizeTimer: number | null = null

  function update() {
    const v = readViewport()
    width.value = v.width
    height.value = v.height
    name.value = resolveBreakpoint(v.width)
  }

  function onResize() {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null
      update()
    }, 200)
  }

  onMounted(() => {
    update()
    window.addEventListener('resize', onResize, { passive: true })
  })

  onBeforeUnmount(() => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer)
    window.removeEventListener('resize', onResize)
  })

  const isNarrow = computed(() => name.value === 'xs' || name.value === 'sm')
  const isWide = computed(() => name.value === 'lg' || name.value === 'xl')
  const isMobile = computed(() => name.value === 'xs')

  return { name, width, height, isNarrow, isWide, isMobile }
}
