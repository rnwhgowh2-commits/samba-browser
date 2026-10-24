// 뒤에서 도는 자동화 탭(보이는 탭 아래 층에 붙은 뷰) 정리 규칙 — Electron 없이 시험하려고 떼어 둔 순수 함수.
//
// 창에 붙지 않은 WebContentsView 는 뷰포트가 0 이라(innerHeight 0, getBoundingClientRect 판정 전부 false)
// 스냅샷이 페이지 끝 구매 버튼을 잘라 먹고 레이아웃·렌더링도 어긋났다(c7d1e5a 회귀).
// 그래서 사람이 쓰는 창에서 자동화가 뒤에서 작업할 탭도 창의 contentView 에 붙이되, 보이는 탭보다 아래에 둔다.

/** 뒤 층에 계속 붙여 둘 탭과 떼어 낼 탭을 가른다 */
export function splitBehind(input: {
  /** 지금 뒤 층에 붙어 있는 탭 id(붙인 순서) */
  behind: readonly string[]
  /** 보이는 탭 id — 뒤 층에 둘 수 없다 */
  activeId: string | null
  /** 전역 자동화 대상 탭 id */
  automationId: string | null
  /** 레인이 쥔 탭 id — 레인이 끝나 닫을 때까지 뒤에서 계속 조작한다 */
  laneIds: ReadonlySet<string>
  /** 살아 있는 탭 id */
  alive: ReadonlySet<string>
}): { keep: string[]; drop: string[] } {
  const keep: string[] = []
  const drop: string[] = []
  const seen = new Set<string>()
  for (const id of input.behind) {
    if (seen.has(id)) continue
    seen.add(id)
    const wanted =
      input.alive.has(id) &&
      id !== input.activeId &&
      (id === input.automationId || input.laneIds.has(id))
    ;(wanted ? keep : drop).push(id)
  }
  return { keep, drop }
}

/**
 * contentView 에 올릴 탭 뷰 순서(아래 → 위). 뒤 탭은 모두 보이는 탭 아래, 보이는 탭이 맨 위다.
 * 보이는 탭이 뒤 목록에 섞여 있어도 한 번만, 맨 위에 둔다
 */
export function stackOrder(activeId: string | null, behind: readonly string[]): string[] {
  const order = behind.filter((id, i) => id !== activeId && behind.indexOf(id) === i)
  if (activeId !== null) order.push(activeId)
  return order
}

/**
 * 레인 탭을 쉬게 하는 기준 시간 — 마지막 도구 호출이 끝나고 이만큼 지나면 뒤 층에서 뗀다.
 *
 * 왜: 세션 관리자가 계정 탭 37개를 레인으로 열어 두면 37개가 모두 창 크기 그대로 뒤 층에 붙어 스로틀링 없이
 * 계속 그려졌다(실기 2026-10-24: 렌더러 62개·CPU 약 2.2코어, GPU 합성은 소프트웨어). 격리 실험에서 뒤 층 30개를
 * 떼고 스로틀링을 켜면 CPU 130% → 39%, 도구가 다시 쓰면 0.1초 안에 다시 그린다
 */
export const LANE_IDLE_MS = 60_000

/**
 * 뒤 층에 붙여 둘 레인 탭 — 도구 호출이 진행 중이거나, 마지막으로 쓴 지 idleMs 가 안 된 탭.
 * 쓴 기록이 없는 탭은 쉬는 탭으로 본다(열 때 기록하므로 정상 흐름에서는 없다)
 */
export function hotLaneIds(input: {
  laneIds: ReadonlySet<string>
  touchedAt: ReadonlyMap<string, number>
  busy: ReadonlyMap<string, number>
  now: number
  idleMs?: number
}): Set<string> {
  const idleMs = input.idleMs ?? LANE_IDLE_MS
  const hot = new Set<string>()
  for (const id of input.laneIds) {
    if ((input.busy.get(id) ?? 0) > 0) {
      hot.add(id)
      continue
    }
    const at = input.touchedAt.get(id)
    if (at !== undefined && input.now - at < idleMs) hot.add(id)
  }
  return hot
}

/**
 * 쉬는 레인 탭의 페이지를 비우는 기준 시간 — 마지막으로 쓴 지 이만큼 지나면 가벼운 빈 페이지로 바꿔 메모리를 돌려준다.
 *
 * 왜: 뒤 층에서 떼어도(LANE_IDLE_MS) 페이지는 살아 있어 메모리는 그대로였다(실기 2026-10-24: 계정 탭 37개, 앱 WS 17.6GB).
 * 같은 탭(WebContents)에서 다른 출처 페이지로 옮기면 옛 렌더러 프로세스가 끝나 메모리가 풀리고(격리 실험 371MB → 21MB),
 * 쿠키·localStorage·탭의 sessionStorage 는 그대로 남는다. 다시 쓰면 원래 주소를 다시 연다
 */
export const DISCARD_IDLE_MS = 10 * 60_000

/** 비운 탭이 보여 주는 가벼운 페이지(출처가 달라 옛 렌더러가 끝난다). 다시 쓰면 곧바로 원래 주소로 돌아간다 */
export const DISCARDED_PAGE_URL =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><title>잠든 탭</title><body style="font:14px sans-serif;color:#888;padding:24px">' +
      '메모리를 아끼려고 잠시 비워 둔 탭입니다. 다시 열면 원래 페이지를 불러옵니다.</body>'
  )

// 비우면 안 되는 화면 — 다시 불러오면 입력·진행이 사라지거나 결과가 달라지는 주문·결제·로그인·인증 흐름
const KEEP_PAGE_RE =
  /(order|checkout|cart|basket|payment|\/pay|pay\.|billing|login|logon|signin|sign-in|auth|oauth|certif|verify|join|signup|register|mypage\/claim|cancel|return)/i

/** 이 주소의 페이지를 비워도 되는가 — http(s) 이고 주문·결제·로그인 화면이 아니어야 한다 */
export function discardableUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  return !KEEP_PAGE_RE.test(url)
}

/** 페이지 안에서 확인한 상태 — 사람·자동화가 누른 적이 있거나 입력하다 만 칸이 있으면 비우지 않는다 */
export interface PageKeepProbe {
  /** navigator.userActivation.hasBeenActive — 누른 적이 있으면 이동 때 '떠나시겠습니까' 확인 창이 뜰 수 있다 */
  activated: boolean
  /** 기본값과 다른 입력 칸이 있다(입력하다 만 내용) */
  dirty: boolean
}

/** 페이지 안 확인 결과로 비워도 되는가. 확인이 실패(시간 초과·오류)했으면 비우지 않는다 */
export function discardableProbe(probe: unknown): boolean {
  if (typeof probe !== 'object' || probe === null) return false
  const p = probe as Partial<PageKeepProbe>
  return p.activated === false && p.dirty === false
}

/** 페이지 안에서 돌리는 확인 스크립트(결과는 PageKeepProbe) */
export const PAGE_KEEP_PROBE_JS = `(() => {
  const activated = !!(navigator.userActivation && navigator.userActivation.hasBeenActive)
  let dirty = false
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (el.type === 'hidden' || el.disabled) continue
    if (el.tagName === 'SELECT') {
      if ([...el.options].some((o) => o.selected !== o.defaultSelected)) { dirty = true; break }
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== el.defaultChecked) { dirty = true; break }
    } else if (el.value !== el.defaultValue) { dirty = true; break }
  }
  return { activated, dirty }
})()`

// 페이지를 쓰지 않는 도구 — 이 도구들 앞에서는 비워 둔 탭을 다시 열지 않는다(세션 관리자가 회차마다 부르는 list_tabs 가
// 레인의 마지막 탭을 매번 다시 열어 영영 비우지 못하던 문제). 목록에 없는 도구는 안전하게 다시 연 뒤 실행한다
const PAGE_FREE_TOOLS = new Set([
  'new_tab',
  'list_tabs',
  'switch_tab',
  'close_tab',
  'progress',
  'remember_site',
  'save_script',
  'list_playbooks',
  'update_playbook',
  'done'
])

/** 이 도구를 실행하기 전에 대상 탭(비워 둔 탭이면)을 다시 열어야 하는가. phone_* 는 폰을 조작하므로 탭이 필요 없다 */
export function toolNeedsPage(name: string): boolean {
  const bare = name.replace(/^mcp__samba__/, '')
  return !PAGE_FREE_TOOLS.has(bare) && !bare.startsWith('phone_')
}
