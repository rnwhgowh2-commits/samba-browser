// 프로필 → 계정 이름표. 프로필 이름(musinsa-2)은 파티션 폴더 이름이라 바꾸면 로그인이 사라지므로,
// 화면에는 따로 적어 둔 계정 이름(cdhking00)을 보여 준다. 파일은 세션 관리자(tools/session-keeper)가
// sites.json 의 accounts 에서 만들어 앱 데이터 폴더에 둔다: { "musinsa-2": "cdhking00", ... }
// 값은 비밀이 아닌 계정 이름뿐이다(비밀번호·쿠키 없음).

import { existsSync, readFileSync, statSync } from 'fs'

/** 파일 내용 → 이름표 지도(순수 함수). 깨졌거나 형식이 틀리면 빈 지도 */
export function parseProfileLabels(text: string): Record<string, string> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim() && v.length <= 40) out[k] = v.trim()
  }
  return out
}

/**
 * 세션 관리자 설정(sites.json)의 accounts 에서 프로필 → 계정 이름 지도를 만든다(순수 함수).
 * 앱 데이터 폴더에 따로 파일을 두면 실행 환경에 따라 앱이 다른 폴더를 보는 일이 있어, 저장소 안의 한 파일을 직접 읽는다.
 * 'default' 프로필은 여러 소싱처가 함께 쓰므로 이름표를 만들지 않는다
 */
export function parseSitesAccountLabels(text: string): Record<string, string> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  const sites = (raw as { sites?: unknown } | null)?.sites
  if (!Array.isArray(sites)) return {}
  const out: Record<string, string> = {}
  for (const site of sites as Array<{ enabled?: unknown; accounts?: unknown }>) {
    if (!site || site.enabled === false || !Array.isArray(site.accounts)) continue
    for (const a of site.accounts as Array<{ profile?: unknown; accountLabel?: unknown }>) {
      if (typeof a?.profile !== 'string' || typeof a?.accountLabel !== 'string') continue
      const label = a.accountLabel.trim()
      if (a.profile === 'default' || !label || label.length > 40) continue
      out[a.profile] = label
    }
  }
  return out
}

/** sites.json 에서 프로필 → 소싱처 id 지도(순수 함수). 페이지 주소가 아직 안 떠도 탭을 제 소싱처 묶음에 넣는 데 쓴다 */
export function parseSitesProfileSites(text: string): Record<string, string> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  const sites = (raw as { sites?: unknown } | null)?.sites
  if (!Array.isArray(sites)) return {}
  const out: Record<string, string> = {}
  for (const site of sites as Array<{ id?: unknown; enabled?: unknown; accounts?: unknown }>) {
    if (!site || site.enabled === false || typeof site.id !== 'string' || !Array.isArray(site.accounts)) continue
    for (const a of site.accounts as Array<{ profile?: unknown }>) {
      if (typeof a?.profile === 'string' && a.profile !== 'default') out[a.profile] = site.id
    }
  }
  return out
}

/**
 * sites.json 최상위 "workspaceId" — 자동화 레인 탭(세션 관리자 등)이 쓸 작업공간 번호(로그인이 들어 있는 곳).
 * 지도 형태({ workspaceId: '2' })로 돌려줘 createProfileLabelReader 를 그대로 쓴다. 정수가 아니면 빈 지도
 */
export function parseSitesWorkspace(text: string): Record<string, string> {
  try {
    const id = (JSON.parse(text) as { workspaceId?: unknown } | null)?.workspaceId
    return typeof id === 'number' && Number.isInteger(id) && id > 0 && id < 1000 ? { workspaceId: String(id) } : {}
  } catch {
    return {}
  }
}

/** 파일이 바뀌었을 때만 다시 읽는 지도(탭 목록을 만들 때마다 불려도 가볍게) */
export function createProfileLabelReader(
  filePath: string,
  parse: (text: string) => Record<string, string> = parseProfileLabels
): (profile: string) => string | undefined {
  let mtime = -1
  let cache: Record<string, string> = {}
  return (profile) => {
    try {
      if (!existsSync(filePath)) return undefined
      const m = statSync(filePath).mtimeMs
      if (m !== mtime) {
        mtime = m
        cache = parse(readFileSync(filePath, 'utf8'))
      }
    } catch {
      return undefined
    }
    return cache[profile]
  }
}
