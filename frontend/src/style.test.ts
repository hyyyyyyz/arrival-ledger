import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

describe('page scrolling safeguards', () => {
  it('keeps root vertical scrolling native and clips horizontal overflow at the app shell', () => {
    expect(declarations('html')).not.toContain('overflow-x: hidden')
    expect(declarations('body')).not.toContain('overflow-x: hidden')
    expect(declarations('body')).toContain('overscroll-behavior-y: auto')
    expect(declarations('.app-shell')).toContain('overflow-x: clip')
  })

  it('prevents horizontal filter strips from capturing vertical overflow', () => {
    const filters = css.match(/\.platform-filters,\s*\n\.arrival-filters\s*\{([^}]*)\}/)?.[1] || ''
    expect(filters).toContain('overflow-x: auto')
    expect(filters).toContain('overflow-y: hidden')
  })

  it('lets the page scroll through manual previews and keeps full tracking numbers selectable', () => {
    expect(declarations('.manual-preview-list')).not.toContain('overflow-y')
    expect(declarations('.manual-preview-list')).not.toContain('max-height')
    expect(declarations('.manual-preview-list strong')).toContain('overflow-x: auto')
    expect(declarations('.manual-preview-list strong')).toContain('user-select: text')
    expect(declarations('.manual-preview-list strong')).not.toContain('ellipsis')
  })
})
