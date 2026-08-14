/** StarHub terminal view: a whole-pane same-origin iframe onto the StarHub frontend. */

import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * P0 placeholder: the pane is one iframe pointed at `/starhub/` (the path the
 * P1 host-static mount will serve the StarHub dist under). The view reads
 * nothing from the session kit; the props share stays formally typed so the
 * registration type-checks against the slot's owner contract.
 * @param _props - conversation view framework kit, unused by the iframe.
 * @returns the full-size iframe element.
 */
export function StarHubTerminalView(_props: ConvViewProps) {
  return (
    <iframe
      title="starhub-terminal"
      src="/starhub/"
      style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
    />
  )
}
