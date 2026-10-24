// 사이드바(접기·섹션·열린 탭 줄)의 순수 계산만 모아 둔 곳.
// React 를 쓰지 않으므로 그대로 단위 테스트할 수 있다

import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_SECTION_KEYS,
  type SidebarSectionKey,
  type SidebarSections
} from '@shared/settings'
import { normalizeHost, registrableDomain } from '@shared/host'
import { isHttpUrl } from '@shared/url'

export { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_SECTION_KEYS }
export type { SidebarSectionKey, SidebarSections }

/**
 * 사이드바 위쪽 이동 항목(적힌 순서가 곧 화면 순서).
 * 눌러도 아무 데도 가지 않는 자리표시자는 두지 않는다 — 모든 항목에 갈 뷰가 있다.
 * 폰은 설정 안으로 옮겼다(설정 → 폰) — 매일 여는 화면이 아니라 연결할 때만 쓴다.
 * 아이콘은 컴포넌트가 붙이고, view 가 실제 MainView 인지도 컴포넌트에서 검사한다
 */
export const SIDEBAR_ITEMS = [
  { key: 'browser', view: 'browser' },
  { key: 'tasks', view: 'tasks' },
  { key: 'logs', view: 'logs' }
] as const satisfies readonly { key: string; view: string }[]

/** 접힌 사이드바는 사용자가 끌어 둔 폭과 무관하게 아이콘 폭으로 고정된다 */
export function sidebarWidthOf(collapsed: boolean, width: number): number {
  return collapsed ? SIDEBAR_COLLAPSED_WIDTH : width
}

/** 폭 조절 손잡이는 펼친 상태에서만 쓸 수 있다(접힌 폭은 고정) */
export function canResizeSidebar(collapsed: boolean): boolean {
  return !collapsed
}

/** 값이 없거나 망가진 섹션은 펼침으로 본다 — 사용자가 내용을 잃어버리지 않게 */
export function isSectionOpen(
  sections: Partial<SidebarSections> | undefined,
  key: SidebarSectionKey
): boolean {
  return sections?.[key] !== false
}

/** 섹션 하나만 뒤집은 새 객체를 돌려준다(원본은 그대로 둔다) */
export function toggleSection(
  sections: Partial<SidebarSections> | undefined,
  key: SidebarSectionKey
): SidebarSections {
  const next = {} as SidebarSections
  for (const k of SIDEBAR_SECTION_KEYS) next[k] = isSectionOpen(sections, k)
  next[key] = !next[key]
  return next
}

/**
 * 접힌 사이드바에서는 섹션 내용이 보이지 않으므로, 섹션이 펼쳐져 있어도 본문을 그리지 않는다.
 * (접기를 풀면 원래 펼침 상태가 그대로 돌아온다)
 */
export function showSectionBody(
  collapsed: boolean,
  sections: Partial<SidebarSections> | undefined,
  key: SidebarSectionKey
): boolean {
  return !collapsed && isSectionOpen(sections, key)
}

/** 열린 탭 줄에 쓸 파비콘 호스트. http(s) 가 아니면(새 탭·빈 페이지) 빈 문자열 */
export function tabFaviconHost(url: string): string {
  if (!isHttpUrl(url)) return ''
  const host = normalizeHost(url)
  return host
}

/** 열린 탭 줄에 보여 줄 제목. 제목이 비면 주소로, 그것도 비면 넘겨받은 기본 문구로 떨어진다 */
export function tabRowLabel(tab: { title: string; url: string }, fallback: string): string {
  return tab.title.trim() || tab.url.trim() || fallback
}

/**
 * 열린 탭을 묶을 때 쓰는 소싱처·판매처 이름표(호스트 끝부분 → 화면에 보일 이름).
 * 여기 없는 사이트는 등록 도메인(예: example.com)으로 묶는다
 */
const SITE_GROUPS: readonly { host: string; name: string }[] = [
  { host: 'musinsa.com', name: '무신사' },
  { host: '29cm.co.kr', name: '29CM' },
  { host: 'a-rt.com', name: 'ABC마트' },
  { host: 'ssg.com', name: 'SSG' },
  { host: 'lotteon.com', name: '롯데온' },
  { host: 'lotteimall.com', name: '롯데아이몰' },
  { host: 'gsshop.com', name: 'GS샵' },
  { host: 'ssfshop.com', name: 'SSF샵' },
  { host: 'thehyundai.com', name: '더현대' },
  { host: 'hmall.com', name: 'H몰' },
  { host: 'fashionplus.co.kr', name: '패션플러스' },
  { host: 'galleria.co.kr', name: '갤러리아' },
  { host: 'lfmall.co.kr', name: 'LF몰' },
  { host: 'nike.com', name: '나이키' },
  { host: 'gmarket.co.kr', name: 'G마켓' },
  { host: 'auction.co.kr', name: '옥션' },
  { host: 'coupang.com', name: '쿠팡' },
  { host: '11st.co.kr', name: '11번가' },
  { host: 'naver.com', name: '네이버' },
  { host: 'okcashbag.com', name: 'OK캐쉬백' },
  { host: 'samba-ybb.com', name: '삼바웨이브' },
  { host: 'samba-wave.vercel.app', name: '삼바웨이브' },
  { host: 'localhost', name: '삼바웨이브' }
]

/** 세션 관리자 소싱처 id → 묶음 이름(SITE_GROUPS 의 이름과 같아야 한다) */
const SITE_ID_NAMES: Record<string, string> = {
  MUSINSA: '무신사',
  LFmall: 'LF몰',
  NAVERSTORE: '네이버',
  '29CM': '29CM',
  ABCmart: 'ABC마트'
}

export interface TabGroup<T> {
  /** 묶음 구분값(이름표의 이름 또는 등록 도메인, 웹이 아니면 빈 문자열) */
  key: string
  /** 화면에 보일 이름. 웹 주소가 아닌 탭(새 탭 등)은 넘겨받은 기본 문구 */
  label: string
  tabs: T[]
}

/** 탭 주소가 속한 소싱처 이름. 이름표에 없으면 등록 도메인, 웹 주소가 아니면 빈 문자열 */
export function siteGroupOf(url: string): string {
  if (!isHttpUrl(url)) return ''
  const host = normalizeHost(url)
  if (!host) return ''
  const hit = SITE_GROUPS.find((g) => host === g.host || host.endsWith(`.${g.host}`))
  return hit ? hit.name : registrableDomain(host)
}

/**
 * 열린 탭을 소싱처별로 묶는다. 묶음 순서는 그 묶음의 첫 탭이 나온 순서, 묶음 안 순서는
 * 원래 탭 순서를 그대로 지킨다(탭 바와 순서가 어긋나지 않게)
 */
export function groupTabsBySite<T extends { url: string; profileSite?: string }>(
  tabs: readonly T[],
  fallbackLabel: string
): TabGroup<T>[] {
  const groups: TabGroup<T>[] = []
  const byKey = new Map<string, TabGroup<T>>()
  for (const tab of tabs) {
    // 주소가 아직 안 떴으면(로딩 중) 그 프로필의 소싱처로 묶는다
    const key = siteGroupOf(tab.url) || (tab.profileSite ? (SITE_ID_NAMES[tab.profileSite] ?? '') : '')
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: key || fallbackLabel, tabs: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.tabs.push(tab)
  }
  return groups
}
