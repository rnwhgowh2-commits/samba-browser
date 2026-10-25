import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { BrowserWindow } from 'electron'
import { TabManager, type Tab } from '../src/main/browser/tab-manager'
import {
  markHumanInWindow,
  runAsAutomation,
  runFromBridge
} from '../src/main/browser/human-activity'

function setup(behind = true): {
  manager: TabManager
  repaint: MockInstance<TabManager['repaintActive']>
  a: Tab
  b: Tab
  children: Tab['view'][]
  win: BrowserWindow
} {
  vi.useFakeTimers()
  const bounds = { x: 0, y: 0, width: 800, height: 600 }
  const makeTab = (id: string): Tab => {
    let throttling = false
    let viewBounds = { ...bounds }
    return {
      id,
      profile: 'default',
      mobile: false,
      view: {
        getBounds: () => viewBounds,
        setBounds: vi.fn((value: typeof bounds) => {
          viewBounds = { ...value }
        }),
        webContents: {
          isDestroyed: () => false,
          getURL: () => 'https://example.com/',
          getBackgroundThrottling: () => throttling,
          setBackgroundThrottling: vi.fn((value: boolean) => {
            throttling = value
          }),
          invalidate: vi.fn()
        }
      } as unknown as Tab['view']
    }
  }
  const a = makeTab('a')
  const b = makeTab('b')
  const children = behind ? [b.view, a.view] : [a.view]
  const win = {
    once: vi.fn(),
    on: vi.fn(),
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
    contentView: {
      children,
      removeChildView: (view: Tab['view']) => {
        const i = children.indexOf(view)
        if (i >= 0) children.splice(i, 1)
      },
      addChildView: (view: Tab['view'], at?: number) => {
        const i = children.indexOf(view)
        if (i >= 0) children.splice(i, 1)
        children.splice(at ?? children.length, 0, view)
      }
    }
  } as unknown as BrowserWindow
  const manager = new TabManager(win)
  Object.assign(manager, {
    tabs: [a, b],
    activeId: 'a',
    behindIds: behind ? ['b'] : [],
    laneIds: new Set(behind ? ['b'] : []),
    laneTouchedAt: new Map([['b', Date.now()]]),
    emit: vi.fn(),
    noteVisit: vi.fn()
  })
  manager.setLayout({ x: 0, y: 0, width: 800, height: 600 })
  const repaint = vi.spyOn(manager, 'repaintActive')
  return { manager, repaint, a, b, children, win }
}

afterEach(() => vi.useRealTimers())

describe('탭 전환 뒤 네이티브 화면 복구', () => {
  it('브릿지의 뒤 탭 캡처가 끝날 때까지 사람의 화면을 가리지 않는다', async () => {
    const { manager, a, children } = setup()
    let finish!: () => void
    const pending = runFromBridge('bridge', () =>
      manager.withFront(
        'b',
        () =>
          new Promise<void>((r) => {
            finish = r
          })
      )
    )
    expect(children.at(-1)).toBe(a.view)
    finish()
    await pending
    expect(children.at(-1)).toBe(a.view)
    manager.dispose()
  })

  it('캡처 중 사람이 탭을 바꾸면 종료 뒤에도 새로 선택한 탭을 유지한다', async () => {
    const { manager, b, children } = setup()
    let finish!: () => void
    const pending = manager.withFront(
      'b',
      () =>
        new Promise<void>((r) => {
          finish = r
        })
    )
    manager.activate('b', { by: 'user' })
    finish()
    await pending
    expect(manager.active()?.id).toBe('b')
    expect(children.at(-1)).toBe(b.view)
    manager.dispose()
  })

  it('자동화 표식이 없는 읽기 도구도 최근 사람 입력이 있으면 화면을 가리지 않는다', async () => {
    const { manager, a, children, win } = setup()
    markHumanInWindow(win)
    await manager.withFront('b', async () => {
      expect(children.at(-1)).toBe(a.view)
    })
    expect(children.at(-1)).toBe(a.view)
    manager.dispose()
  })
  it('복구 크기를 한 프레임 이상 유지한 뒤 원래대로 복원한다', async () => {
    const { manager, a } = setup()
    const before = { ...a.view.getBounds() }
    manager.repaintActive('test')
    const shrunk = { ...a.view.getBounds() }
    expect(shrunk.width).toBe(before.width - 1)
    await vi.advanceTimersByTimeAsync(31)
    expect(a.view.getBounds()).toEqual(shrunk)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.view.getBounds()).toEqual(before)
    manager.dispose()
  })

  it('복구를 기다리는 동안 새 배치가 적용되면 옛 크기로 되돌리지 않는다', async () => {
    const { manager, a } = setup()
    manager.repaintActive('test')
    const next = { x: 10, y: 20, width: 900, height: 700 }
    a.view.setBounds(next)
    await vi.advanceTimersByTimeAsync(32)
    expect(a.view.getBounds()).toEqual(next)
    manager.dispose()
  })

  it('복구 요청이 겹쳐도 크기를 계속 줄이지 않는다', async () => {
    const { manager, b } = setup()
    const before = { ...b.view.getBounds() }
    manager.repaintTab('b', 'first')
    manager.repaintTab('b', 'second')
    expect(b.view.getBounds().width).toBe(before.width - 1)
    await vi.advanceTimersByTimeAsync(32)
    expect(b.view.getBounds()).toEqual(before)
    manager.dispose()
  })

  it.each([true, false])('뒤 층 여부 %s인 탭도 다음 이벤트에서 두 번 복구한다', async (behind) => {
    const { manager, repaint } = setup(behind)
    manager.activate('b', { by: 'user' })
    expect(repaint).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(repaint).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1050)
    expect(repaint).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1200)
    expect(repaint).toHaveBeenCalledTimes(2)
    manager.dispose()
  })

  it('A→B→A→B로 돌아와도 첫 B의 예약은 실행하지 않는다', async () => {
    const { manager, repaint } = setup(false)
    Object.assign(manager, { laneIds: new Set(['a', 'b']) })
    manager.activate('b', { by: 'user' })
    await vi.advanceTimersByTimeAsync(50)
    manager.activate('a', { by: 'user' })
    await vi.advanceTimersByTimeAsync(50)
    manager.activate('b', { by: 'user' })
    await vi.advanceTimersByTimeAsync(50)
    expect(repaint).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(repaint).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('같은 탭을 다시 눌러도 아직 남은 복구 예약을 취소하지 않는다', async () => {
    const { manager, repaint } = setup()
    manager.activate('b', { by: 'user' })
    await vi.advanceTimersByTimeAsync(50)
    manager.activate('b', { by: 'user' })
    await vi.advanceTimersByTimeAsync(100)
    expect(repaint).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('같은 탭 재선택과 명시적 복구는 추가 복구를 예약하지 않는다', async () => {
    const { manager, repaint } = setup()
    manager.activate('a', { by: 'user' })
    manager.repaintActive('shortcut')
    await vi.advanceTimersByTimeAsync(1500)
    expect(repaint).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it('예약 복구는 대상 뷰만 다시 붙이고 위에 열린 확장 팝업을 보존한다', async () => {
    const { manager, b, children, win } = setup()
    manager.activate('b', { by: 'user' })
    const remove = vi.spyOn(win.contentView, 'removeChildView')
    const overlay = {} as Tab['view']
    children.push(overlay)
    await vi.advanceTimersByTimeAsync(150)
    expect(remove.mock.calls).toEqual([[b.view]])
    expect(children.at(-1)).toBe(overlay)
    manager.dispose()
  })

  it('뒤 탭이 여러 개여도 선택한 탭만 앞으로 옮긴다', () => {
    const { manager, a, b, children, win } = setup()
    Object.assign(manager, { laneIds: new Set(['a', 'b']) })
    const remove = vi.spyOn(win.contentView, 'removeChildView')
    const add = vi.spyOn(win.contentView, 'addChildView')
    manager.activate('b', { by: 'user' })
    expect(remove).not.toHaveBeenCalled()
    expect(add.mock.calls).toEqual([[b.view]])
    expect(children).toEqual([a.view, b.view])
    expect(b.view.webContents.getBackgroundThrottling()).toBe(false)
    manager.dispose()
  })

  it('같은 탭을 다시 선택해도 네이티브 뷰를 재부착하지 않는다', () => {
    const { manager, win } = setup()
    const remove = vi.spyOn(win.contentView, 'removeChildView')
    const add = vi.spyOn(win.contentView, 'addChildView')
    manager.activate('a', { by: 'user' })
    expect(remove).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('선택한 탭은 스로틀링을 끄고 가려진 일반 탭만 스로틀링한다', () => {
    const { manager, a, b } = setup(false)
    b.view.webContents.setBackgroundThrottling(true)
    manager.activate('b', { by: 'user' })
    expect(b.view.webContents.getBackgroundThrottling()).toBe(false)
    expect(a.view.webContents.getBackgroundThrottling()).toBe(true)
    manager.dispose()
  })

  it('전환 뒤 클릭이나 입력이 시작되면 늦은 복구가 조작을 끊지 않는다', async () => {
    const { manager, repaint, win } = setup()
    manager.activate('b', { by: 'user' })
    await vi.advanceTimersByTimeAsync(200)
    expect(repaint).toHaveBeenCalledTimes(1)
    markHumanInWindow(win)
    await vi.advanceTimersByTimeAsync(1200)
    expect(repaint).toHaveBeenCalledTimes(1)
    manager.dispose()
  })

  it.each(['dispose', 'gate', 'capture'])('%s 중이면 예약된 재부착을 하지 않는다', async (mode) => {
    const { manager, repaint } = setup()
    manager.activate('b', { by: 'user' })
    if (mode === 'dispose') manager.dispose()
    else Object.assign(manager, mode === 'gate' ? { gateHidden: true } : { frontDepth: 1 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(repaint).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('브릿지가 뒤쪽 작업 탭만 고르면 사람의 화면을 다시 붙이지 않는다', async () => {
    const { manager, repaint, a, children } = setup()
    await runFromBridge('bridge', () => runAsAutomation(async () => manager.activate('b')))
    await vi.advanceTimersByTimeAsync(1500)
    expect(manager.active()?.id).toBe('a')
    expect(children.at(-1)).toBe(a.view)
    expect(repaint).not.toHaveBeenCalled()
    manager.dispose()
  })
})
