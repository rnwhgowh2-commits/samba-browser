// 사이트별 쿠키 삭제 — 쿠키가 쌓여 서버가 "400 Request Header Or Cookie Too Large" 로 사이트 전체를 막을 때(H몰, 2026-10-24)
// 앱을 다시 켜지 않고 그 사이트의 쿠키만 지운다. 세션 관리자가 브릿지(POST /cookies/clear)로 부른다.
// 로그인 사이트 허용 목록(session-cookie-snapshot.ts SNAPSHOT_SITES)에 있는 호스트만 지울 수 있다.
// 쿠키 값은 읽어도 로그·반환값에 남기지 않는다(개수만 돌려준다).

import type { Cookie, Session } from 'electron'
import { isSnapshotHost } from './session-cookie-snapshot'

/** 이 모듈이 쿠키 저장소에서 쓰는 부분만(테스트에서 대역으로 갈아 끼운다) */
export interface ClearableJar {
  get(filter: Record<string, unknown>): Promise<Cookie[]>
  remove(url: string, name: string): Promise<void>
}

/** 쿠키가 이 사이트(등록 도메인과 그 하위) 것인가 */
export function cookieBelongsToSite(c: Pick<Cookie, 'domain'>, site: string): boolean {
  const d = (c.domain ?? '').replace(/^\./, '').toLowerCase()
  const s = site.toLowerCase()
  return !!d && (d === s || d.endsWith(`.${s}`))
}

/** 저장소에서 그 사이트의 쿠키를 모두 지운다. 지운 개수와 지우지 못한 개수를 돌려준다(값은 담지 않는다) */
export async function clearSiteCookiesIn(jar: ClearableJar, site: string): Promise<{ removed: number; failed: number }> {
  const all = await jar.get({})
  let removed = 0
  let failed = 0
  for (const c of all) {
    if (!cookieBelongsToSite(c, site)) continue
    const host = (c.domain ?? '').replace(/^\./, '')
    const url = `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`
    try {
      await jar.remove(url, c.name)
      removed++
    } catch {
      // 한 개가 실패해도 나머지는 계속 지운다 — 실패 개수는 호출부가 볼 수 있게 센다
      failed++
    }
  }
  return { removed, failed }
}

/** 프로필 이름 규칙(경로·파티션 이름에 쓰이므로 안전한 글자만) */
export function isSafeProfileName(profile: string): boolean {
  return /^[A-Za-z0-9가-힣_.-]{1,80}$/.test(profile)
}

/** 탭 관리자가 구현하는 부분 — 프로필의 세션을 돌려준다(automation 이면 자동화 레인이 쓰는 고정 작업공간 쪽) */
export interface CookieClearTarget {
  sessionFor(profile: string, automation: boolean): Session
}

let target: CookieClearTarget | null = null

export function setCookieClearTarget(t: CookieClearTarget | null): void {
  target = t
}

export type ClearResult = { ok: true; removed: number; failed: number } | { ok: false; error: string }

/** 브릿지 입구가 부르는 진입점. 입력을 검증한 뒤 지운다 */
export async function clearSiteCookies(req: {
  profile?: unknown
  host?: unknown
  automation?: unknown
}): Promise<ClearResult> {
  if (!target) return { ok: false, error: 'not ready' }
  if (typeof req.profile !== 'string' || !isSafeProfileName(req.profile)) {
    return { ok: false, error: 'invalid profile' }
  }
  if (typeof req.host !== 'string' || !isSnapshotHost(req.host)) {
    return { ok: false, error: 'host not allowed' }
  }
  const ses = target.sessionFor(req.profile, req.automation !== false)
  const { removed, failed } = await clearSiteCookiesIn(ses.cookies as unknown as ClearableJar, req.host.replace(/^\./, ''))
  return { ok: true, removed, failed }
}
