// StarHub brand wordmark: "StarHub" letterforms + "deepseek harness" badge
// plate in one svg. Native 182x24. Ink rides currentColor; the badge text is
// knocked out in the inverted label color so the plate stays legible in both
// themes. The wordmark is system-font text rather than hand-drawn paths.

import type { IconProps } from './icons/props.ts'

/** System font stack shared by the wordmark and the badge text. */
const WORDMARK_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; width keeps the 182:24 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={(size * 182) / 24}
      height={size}
      className={className}
      viewBox="0 0 182 24"
      fill="none"
      aria-hidden="true"
    >
      <text
        x="0"
        y="19.8"
        fontSize="24"
        fontWeight="600"
        fill="currentColor"
        fontFamily={WORDMARK_FONT}
      >
        StarHub
      </text>
      <rect x="104" y="5.5" width="78" height="14" rx="2" fill="currentColor" />
      <text
        x="108.5"
        y="15.3"
        fontSize="8"
        letterSpacing="0.15"
        fill="var(--dsw-alias-label-primary-inverted)"
        fontFamily={WORDMARK_FONT}
      >
        deepseek harness
      </text>
    </svg>
  )
}
