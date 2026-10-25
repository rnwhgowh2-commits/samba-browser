// 뒤에서 도는 자동화 탭의 층(z-order) 규칙 회귀 테스트(c7d1e5a 회귀: 창에 붙지 않은 탭은 뷰포트가 0)
import { describe, it, expect } from 'vitest'
import {
  DISCARD_IDLE_MS,
  DISCARDED_PAGE_URL,
  discardableProbe,
  discardableUrl,
  hotLaneIds,
  LANE_DISCARD_ENABLED,
  LANE_IDLE_MS,
  splitBehind,
  stackOrder,
  toolNeedsPage
} from '../src/main/browser/behind-views'

const alive = (...ids: string[]): Set<string> => new Set(ids)

describe('stackOrder — 뒤 탭은 모두 보이는 탭 아래', () => {
  it('뒤 탭을 붙인 순서대로 아래에, 보이는 탭을 맨 위에 둔다', () => {
    expect(stackOrder('v', ['a', 'b'])).toEqual(['a', 'b', 'v'])
  })

  it('보이는 탭이 뒤 목록에 섞여 있어도 맨 위에 한 번만', () => {
    expect(stackOrder('a', ['a', 'b', 'b'])).toEqual(['b', 'a'])
  })

  it('보이는 탭이 없으면 뒤 탭만', () => {
    expect(stackOrder(null, ['a'])).toEqual(['a'])
  })
})

describe('splitBehind — 계속 붙여 둘 뒤 탭', () => {
  it('자동화 대상과 레인 탭은 남기고, 표식이 옮겨 간 옛 탭은 뗀다', () => {
    const r = splitBehind({
      behind: ['old', 'target', 'lane'],
      activeId: 'v',
      automationId: 'target',
      laneIds: new Set(['lane']),
      alive: alive('v', 'old', 'target', 'lane')
    })
    expect(r.keep).toEqual(['target', 'lane'])
    expect(r.drop).toEqual(['old'])
  })

  it('보이는 탭이 된 뒤 탭은 뒤 목록에서 빠진다(스로틀링 복원 대상)', () => {
    const r = splitBehind({
      behind: ['target'],
      activeId: 'target',
      automationId: 'target',
      laneIds: new Set(),
      alive: alive('target')
    })
    expect(r.keep).toEqual([])
    expect(r.drop).toEqual(['target'])
  })

  it('닫힌 탭·중복은 남기지 않는다', () => {
    const r = splitBehind({
      behind: ['lane', 'lane', 'gone'],
      activeId: 'v',
      automationId: 'gone',
      laneIds: new Set(['lane']),
      alive: alive('v', 'lane')
    })
    expect(r.keep).toEqual(['lane'])
    expect(r.drop).toEqual(['gone'])
  })
})

describe('hotLaneIds — 쉬는 레인 탭은 뒤 층에서 뗀다', () => {
  const now = 1_000_000
  it('최근에 쓴 탭은 붙여 두고, 기준 시간이 지난 탭과 쓴 기록 없는 탭은 뗀다', () => {
    const hot = hotLaneIds({
      laneIds: new Set(['fresh', 'stale', 'never']),
      touchedAt: new Map([
        ['fresh', now - LANE_IDLE_MS + 1],
        ['stale', now - LANE_IDLE_MS]
      ]),
      busy: new Map(),
      now
    })
    expect([...hot]).toEqual(['fresh'])
  })

  it('도구 호출이 진행 중인 탭은 오래 지나도 붙여 둔다(문자 인증 대기 같은 긴 호출)', () => {
    const hot = hotLaneIds({
      laneIds: new Set(['a', 'b']),
      touchedAt: new Map([
        ['a', 0],
        ['b', 0]
      ]),
      busy: new Map([
        ['a', 1],
        ['b', 0]
      ]),
      now
    })
    expect([...hot]).toEqual(['a'])
  })

  it('레인이 아닌 id 는 결과에 없다', () => {
    const hot = hotLaneIds({ laneIds: new Set(), touchedAt: new Map([['x', now]]), busy: new Map(), now })
    expect(hot.size).toBe(0)
  })
})

describe('쉬는 레인 탭 페이지 비우기 규칙', () => {
  it('일반 http(s) 페이지만 비운다 — 주문·결제·로그인·인증 화면과 내부 페이지는 두고 간다', () => {
    expect(discardableUrl('https://www.musinsa.com/main')).toBe(true)
    expect(discardableUrl('https://my.musinsa.com/api/member/v1/my-info')).toBe(true)
    for (const u of [
      'https://www.musinsa.com/order/checkout',
      'https://pay.naver.com/x',
      'https://nid.naver.com/nidlogin.login',
      'https://member.ssg.com/member/login.ssg',
      'https://www.lotteon.com/p/order/cart',
      'https://kauth.kakao.com/oauth/authorize',
      'samba://newtab',
      'about:blank',
      DISCARDED_PAGE_URL
    ]) {
      expect(discardableUrl(u), u).toBe(false)
    }
  })

  it('누른 적이 있거나 입력하다 만 칸이 있거나 확인이 실패했으면 비우지 않는다', () => {
    expect(discardableProbe({ activated: false, dirty: false })).toBe(true)
    expect(discardableProbe({ activated: true, dirty: false })).toBe(false)
    expect(discardableProbe({ activated: false, dirty: true })).toBe(false)
    expect(discardableProbe({ timeout: true })).toBe(false)
    expect(discardableProbe(null)).toBe(false)
  })

  it('페이지 비우기는 꺼져 있다 — 비운 탭을 누를 때마다 다시 불러와 느렸다(2026-10-25 사장님 지시)', () => {
    expect(LANE_DISCARD_ENABLED).toBe(false)
  })

  it('비우는 기준 시간은 떼는 기준 시간보다 길다(먼저 떼고, 한참 더 안 쓰면 비운다)', () => {
    expect(DISCARD_IDLE_MS).toBeGreaterThan(LANE_IDLE_MS)
  })
})

describe('toolNeedsPage — 페이지를 쓰지 않는 도구 앞에서는 비운 탭을 다시 열지 않는다', () => {
  it('탭 목록·닫기·새 탭·폰 도구는 다시 열지 않는다', () => {
    for (const n of ['list_tabs', 'close_tab', 'new_tab', 'switch_tab', 'mcp__samba__list_tabs', 'phone_tap']) {
      expect(toolNeedsPage(n), n).toBe(false)
    }
  })
  it('페이지를 읽거나 조작하는 도구와 모르는 도구는 다시 연 뒤 실행한다', () => {
    for (const n of ['get_page', 'click', 'run_js', 'run_script', 'screenshot', 'page_eval', 'network_record', 'login', 'list_accounts', 'some_new_tool']) {
      expect(toolNeedsPage(n), n).toBe(true)
    }
  })
})
