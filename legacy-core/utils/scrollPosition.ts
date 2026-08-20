export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface ScrollAnchor {
  scrollTop: number
  atBottom: boolean
}

/** 记录滚动阅读点；底部容差用于吸收小数像素和渐进渲染造成的轻微偏差。 */
export function captureScrollAnchor(metrics: ScrollMetrics, bottomThreshold = 48): ScrollAnchor {
  return {
    scrollTop: Math.max(0, metrics.scrollTop),
    atBottom: metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= bottomThreshold
  }
}

/** 内容高度变化后恢复阅读点；贴底会话跟随最新内容，历史阅读点保持绝对位置。 */
export function resolveScrollTop(anchor: ScrollAnchor | null, metrics: Pick<ScrollMetrics, 'scrollHeight' | 'clientHeight'>): number {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  if (!anchor || anchor.atBottom) return maxScrollTop
  return Math.min(Math.max(0, anchor.scrollTop), maxScrollTop)
}
