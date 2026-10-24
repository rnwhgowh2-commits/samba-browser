// 레인 보기가 도구 대상을 고를 때 쉬던 레인 탭을 깨우는지(tab-manager sleepIdleLanes 와 짝)
import { describe, it, expect } from 'vitest'
import { laneTabs, newLaneState } from '../src/main/agent/lane-tabs'
import type { Tab, TabManager } from '../src/main/browser/tab-manager'
import type { AgentTarget } from '../src/main/browser/targets'

function fakeReal(targets: AgentTarget[], withTouch = true): { real: TabManager; touched: string[] } {
  const touched: string[] = []
  const tab = (id: string): Tab => ({ id }) as unknown as Tab
  const real = {
    listTargets: () => targets,
    list: () => [],
    get: (id: string) => (targets.some((t) => t.id === id && t.kind === 'tab') ? tab(id) : null),
    targetTab: (id: string) => tab(id),
    ...(withTouch ? { touchLane: (id: string) => touched.push(id) } : {})
  } as unknown as TabManager
  return { real, touched }
}

describe('laneTabs — 도구 대상을 고르면 그 레인 탭을 깨운다', () => {
  const targets: AgentTarget[] = [
    { id: 'a', kind: 'tab', title: '', url: 'https://a', active: false },
    { id: 'b', kind: 'tab', title: '', url: 'https://b', active: false },
    { id: 'pop', kind: 'popup', title: '', url: 'https://pay', openerId: 'b', active: false }
  ]

  it('현재 작업 창(팝업 포함)을 고를 때마다 touchLane 을 부른다', () => {
    const { real, touched } = fakeReal(targets)
    const st = newLaneState()
    st.owned.add('a')
    st.owned.add('b')
    st.current = 'pop'
    const view = laneTabs(real, st)
    expect(view.agentTarget()?.id).toBe('pop')
    st.current = 'a'
    expect(view.agentTarget()?.id).toBe('a')
    expect(touched).toEqual(['pop', 'a'])
  })

  it('작업 창이 닫혀 마지막 탭으로 돌아갈 때도 깨운다', () => {
    const { real, touched } = fakeReal(targets)
    const st = newLaneState()
    st.owned.add('a')
    st.owned.add('b')
    st.current = 'gone'
    expect(laneTabs(real, st).agentTarget()?.id).toBe('b')
    expect(touched).toEqual(['b'])
  })

  it('touchLane 이 없는 대역에서도 그대로 동작한다', () => {
    const { real } = fakeReal(targets, false)
    const st = newLaneState()
    st.owned.add('a')
    st.current = 'a'
    expect(laneTabs(real, st).agentTarget()?.id).toBe('a')
  })
})
