// @vitest-environment jsdom
// SVG 요소(별점 아이콘)도 클릭 도구로 누를 수 있어야 한다 — SVGElement 에는 click() 이 없어
// 'el.click is not a function' 으로 실패했다(실기 2026-10-17 무신사 후기 별점)
import { describe, it, expect } from 'vitest'
import { buildSnapshot, performClick } from '../src/preload/page-core'

describe('performClick — SVG 요소', () => {
  it('click() 메서드가 없는 SVG 별점도 click 이벤트로 누른다', async () => {
    document.body.innerHTML = `
      <div class="StarScore__StarWrapper">
        <svg id="s5" role="button" aria-label="5점" width="10" height="10"><path d="M0 0"/></svg>
      </div>`
    let clicks = 0
    document.getElementById('s5')!.addEventListener('click', () => {
      clicks += 1
    })
    const snap = buildSnapshot()
    const id = snap.elements.find((e) => e.text === '5점' || e.name === '5점')?.id
    expect(id).toBeDefined()
    const result = await performClick(id as number)
    expect(result.startsWith('ok')).toBe(true)
    expect(clicks).toBeGreaterThan(0)
  })
})
