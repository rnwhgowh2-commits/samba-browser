// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scrollPage } from '../src/preload/page-scroll'

function metrics(box: HTMLElement, height: number, content: number, width = 800): void {
  Object.defineProperties(box, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: { configurable: true, value: content },
    clientWidth: { configurable: true, value: width }
  })
  box.getBoundingClientRect = () => ({ top: 0, bottom: height, width, height }) as DOMRect
  box.scrollTo = vi.fn((options: ScrollToOptions) => { box.scrollTop = options.top ?? 0 }) as typeof box.scrollTo
}

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.scrollTop = 0
  vi.restoreAllMocks()
})

describe('실제 스크롤 영역과 이동 결과', () => {
  it('문서가 스크롤되면 이동 전후 좌표를 반환한다', () => {
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: document.documentElement })
    metrics(document.documentElement, 500, 1500)
    expect(scrollPage('down')).toContain('0 -> 400')
    expect(scrollPage('up')).toContain('400 -> 0')
    expect(document.documentElement.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' })
  })

  it('창이 움직이지 않는 앱 화면은 내부 거래 목록을 스크롤한다', () => {
    metrics(document.documentElement, 500, 500)
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    document.body.append(list)
    metrics(list, 400, 2000)
    expect(scrollPage('down')).toContain('div list: 0 -> 320')
    expect(list.scrollTop).toBe(320)
  })

  it('문서 끝에서 옆 메뉴를 스크롤하지 않고 끝이라고 알린다', () => {
    metrics(document.documentElement, 500, 1500)
    document.documentElement.scrollTop = 1000
    const menu = document.createElement('div')
    menu.style.overflowY = 'auto'
    document.body.append(menu)
    metrics(menu, 300, 1000)
    expect(scrollPage('down')).toBe('end (document did not move)')
    expect(menu.scrollTo).not.toHaveBeenCalled()
  })

  it('숨겨진 목록이나 이동하지 않은 화면을 ok로 보고하지 않는다', () => {
    metrics(document.documentElement, 500, 500)
    const hidden = document.createElement('div')
    hidden.style.overflowY = 'auto'
    hidden.style.display = 'none'
    document.body.append(hidden)
    metrics(hidden, 400, 2000)
    expect(scrollPage('down')).toMatch(/^end /)
    hidden.style.display = 'block'
    hidden.scrollTo = vi.fn()
    expect(scrollPage('down')).toMatch(/^end /)
  })
})
