/**
 * StarHub tool-context: pure rendering of the injected tool-context text.
 */
import { describe, expect, it } from 'vitest'
import { renderToolContext } from '../src/index.ts'

describe('renderToolContext', () => {
  it('returns null when neither tool nor asset is set', () => {
    expect(renderToolContext({})).toBeNull()
    expect(renderToolContext({ subcategory: '' })).toBeNull()
    expect(renderToolContext({ assetName: '' })).toBeNull()
  })

  it('renders tool and asset with route when both present', () => {
    const text = renderToolContext({
      subcategory: 'terminal',
      assetId: 'a1',
      assetName: 'prod-server',
      routePrefix: '/ssh',
    })
    expect(text).toContain('Tool: terminal')
    expect(text).toContain('Asset: prod-server')
    expect(text).toContain('Route: /ssh')
  })

  it('omits the route line when routePrefix is absent', () => {
    const text = renderToolContext({ subcategory: 'docker', assetName: 'docker-1' })
    expect(text).toContain('Tool: docker')
    expect(text).not.toContain('Route:')
  })

  it('falls back to the asset id when the display name is absent', () => {
    const text = renderToolContext({ subcategory: 'database', assetId: 'a9' })
    expect(text).toContain('Asset: a9')
  })
})
