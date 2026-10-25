// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSnapshot, performClick, resetElementIds } from '../src/preload/page-core'

afterEach(() => {
  vi.useRealTimers()
  resetElementIds()
})

describe('후기 등록은 응답 지연에도 한 번만 활성화', () => {
  it('버튼과 그 안의 span이 다른 요소 번호여도 같은 제출이다', async () => {
    vi.useFakeTimers()
    document.body.innerHTML =
      '<button type="button">리뷰 등록하기<span role="button">리뷰 등록하기</span></button>'
    const submitted = vi.fn()
    document.querySelector('button')!.addEventListener('click', submitted)
    const ids = buildSnapshot().elements.map((e) => e.id)
    expect(ids.length).toBe(2)
    const first = performClick(ids[0])
    await vi.runAllTimersAsync()
    await first
    const second = performClick(ids[1])
    await vi.runAllTimersAsync()
    expect(await second).toContain('refused')
    expect(submitted).toHaveBeenCalledTimes(1)
  })

  it('비활성 버튼은 예약하지 않고 활성화된 뒤 첫 클릭을 허용한다', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<button type="button" disabled>리뷰 등록하기</button>'
    const button = document.querySelector('button')!
    const submitted = vi.fn()
    button.addEventListener('click', submitted)
    const id = buildSnapshot().elements[0].id
    expect(await performClick(id)).toContain('disabled')
    button.disabled = false
    const pending = performClick(id)
    await vi.runAllTimersAsync()
    await pending
    expect(submitted).toHaveBeenCalledTimes(1)
  })
  it.each(['리뷰 등록하기', '후기 등록', '상품평 저장', '리뷰 수정 완료'])(
    '%s 버튼은 화면이 그대로여도 Enter/좌표 재클릭하지 않는다',
    async (label) => {
      vi.useFakeTimers()
      document.body.innerHTML = `<button type="button">${label}</button>`
      const button = document.querySelector('button')!
      const submitted = vi.fn()
      const enter = vi.fn()
      button.addEventListener('click', submitted)
      button.addEventListener('keydown', enter)
      const id = buildSnapshot().elements[0].id
      const pending = performClick(id)
      await vi.runAllTimersAsync()
      await pending
      expect(submitted).toHaveBeenCalledTimes(1)
      expect(enter).not.toHaveBeenCalled()
    }
  )

  it('같은 버튼의 동시 호출과 응답 유실 뒤 호출도 재제출하지 않는다', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<button type="button">리뷰 등록하기</button>'
    const submitted = vi.fn()
    document.querySelector('button')!.addEventListener('click', submitted)
    const id = buildSnapshot().elements[0].id
    const first = performClick(id)
    const second = performClick(id)
    await vi.runAllTimersAsync()
    await Promise.all([first, second])
    const third = performClick(id)
    await vi.runAllTimersAsync()
    expect(await third).toContain('refused')
    expect(submitted).toHaveBeenCalledTimes(1)
  })
})
