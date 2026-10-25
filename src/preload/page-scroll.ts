/** 창 대신 내부 목록이 스크롤되는 화면도 실제 이동 결과를 확인한다. */
export function scrollPage(dir: 'up' | 'down'): string {
  const sign = dir === 'down' ? 1 : -1
  const root = document.scrollingElement as HTMLElement | null
  const move = (box: HTMLElement, label: string): string | null => {
    const before = box.scrollTop
    const limit = Math.max(0, box.scrollHeight - box.clientHeight)
    const after = Math.max(0, Math.min(limit, before + sign * Math.max(1, box.clientHeight * 0.8)))
    if (Math.abs(after - before) < 1) return null
    // 사이트의 scroll-behavior:smooth 때문에 이동 전 좌표를 성공으로 오인하지 않는다.
    box.scrollTo({ top: after, behavior: 'instant' })
    const actual = box.scrollTop
    if (Math.abs(actual - before) < 1) return null
    return `ok (scrolled ${label}: ${Math.round(before)} -> ${Math.round(actual)}; viewport ${box.clientHeight}; content ${box.scrollHeight})`
  }
  if (root && root.clientHeight > 0) {
    const moved = move(root, 'document')
    if (moved) return moved
    // 문서 끝에서는 옆 메뉴를 잘못 스크롤하지 않는다.
    const limit = root.scrollHeight - root.clientHeight
    if (limit > 1 && ((sign > 0 && root.scrollTop >= limit - 1) || (sign < 0 && root.scrollTop <= 1))) {
      return 'end (document did not move)'
    }
  }
  const boxes = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
    .filter((box) => {
      if (box === root || box.clientHeight <= 0 || box.scrollHeight <= box.clientHeight + 1) return false
      const style = getComputedStyle(box)
      const rect = box.getBoundingClientRect()
      return /(auto|scroll)/.test(style.overflowY) && style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
    })
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)
  // 화면을 가장 넓게 차지하는 목록부터 시도한다. 요소 id를 지정한 스크롤은 기존 경로가 담당한다.
  for (const box of boxes) {
    const moved = move(box, `${box.tagName.toLowerCase()} list`)
    if (moved) return moved
  }
  return 'end (no scrollable page or list moved)'
}
