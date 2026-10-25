import { describe, it, expect } from 'vitest'
import { shouldHoldVisible } from '../src/main/browser/visible-guard'
import { bridgeOrigin, isAutomation, runAsAutomation, runFromBridge } from '../src/main/browser/human-activity'

// 실기 2026-10-24~25: 사람이 60초 입력 없이 보기만 하면 레인 없는 브릿지 new_tab 이 보던 탭을 다른 소싱처로 바꿨다
describe('shouldHoldVisible — 브릿지 요청은 사람 입력과 상관없이 보이는 탭을 지킨다', () => {
  const now = 1_000_000

  it('브릿지 자동화는 사람 입력 기록이 없어도 막는다', () => {
    expect(shouldHoldVisible(true, undefined, now, undefined, true)).toBe(true)
  })

  it('브릿지 자동화는 마지막 입력이 오래전이어도 막는다', () => {
    expect(shouldHoldVisible(true, now - 10 * 60_000, now, undefined, true)).toBe(true)
  })

  it('자동화가 아니면(사람이 탭을 누름) 브릿지 흐름이어도 막지 않는다', () => {
    expect(shouldHoldVisible(false, undefined, now, undefined, true)).toBe(false)
  })

  it('앱 안 AI 패널(브릿지 아님)은 예전처럼 사람이 쉬면 전환한다', () => {
    expect(shouldHoldVisible(true, undefined, now)).toBe(false)
    expect(shouldHoldVisible(true, now - 1_000, now)).toBe(true)
  })
})

describe('runFromBridge — 브릿지 출처는 비동기 흐름을 따라간다', () => {
  it('밖에서는 없고, 안에서는 레인 이름까지 보인다', async () => {
    expect(bridgeOrigin()).toBeUndefined()
    const seen = await runFromBridge('bridge:keeper-MUSINSA-1', async () => {
      await new Promise((r) => setTimeout(r, 1))
      // 도구 실행(runAsAutomation) 안에서도 출처가 이어진다
      return runAsAutomation(async () => {
        await Promise.resolve()
        return { origin: bridgeOrigin(), automation: isAutomation() }
      })
    })
    expect(seen).toEqual({ origin: 'bridge:keeper-MUSINSA-1', automation: true })
    expect(bridgeOrigin()).toBeUndefined()
  })

  it('동시에 도는 두 요청의 출처가 섞이지 않는다', async () => {
    const run = (name: string, ms: number): Promise<string | undefined> =>
      runFromBridge(name, async () => {
        await new Promise((r) => setTimeout(r, ms))
        return bridgeOrigin()
      })
    const [a, b] = await Promise.all([run('bridge', 5), run('bridge:cc-x', 1)])
    expect(a).toBe('bridge')
    expect(b).toBe('bridge:cc-x')
  })
})
