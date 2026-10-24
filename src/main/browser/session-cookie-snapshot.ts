// 로그인 사이트의 host-only 세션 쿠키 보관 — 앱을 껐다 켜도 로그인이 살아 있게 한다.
//
// session-cookies.ts 는 도메인 쿠키(.musinsa.com 같은)의 세션 쿠키만 만료를 얹어 남긴다.
// 로그인 토큰을 host-only 세션 쿠키(예: www.lfmall.co.kr·hi.thehyundai.com)로 주는 사이트는 앱을
// 다시 켜면 로그아웃됐다. host-only 쿠키를 그때그때 덮어쓰면 사이트가 막 바꾼 새 값을 옛 값이
// 되돌리는 사고가 있었으므로(무신사머니 결제창, 2026-09-26) 여기서는 **쓰기를 앱 시작 때 한 번만** 한다:
//   · 실행 중에는 쿠키를 읽어 암호화한 파일에 모아 두기만 하고(쿠키 저장소는 건드리지 않는다)
//   · 다음 시작 때, 저장소에 아직 없는 쿠키만 만료를 얹어 되살린다
// 값은 safeStorage(Windows DPAPI)로 암호화해 파일에만 둔다 — 로그·IPC·렌더러로 나가지 않는다.
// 암호화를 쓸 수 없으면 아무것도 저장하지 않는다(평문 저장 없음).

import { createHash } from 'crypto'
import type { Cookie, CookiesSetDetails } from 'electron'

/** 보관한 쿠키를 되살릴 수 있는 기간 */
export const SNAPSHOT_KEEP_DAYS = 14

/**
 * 보관 대상 사이트(등록 도메인과 그 하위). 로그인 유지가 필요한 소싱처·판매처만 둔다.
 * 결제 도메인(musinsapayments.com 등)은 여기 없고, 이름에 pay 가 든 하위 주소도 따로 거른다
 */
export const SNAPSHOT_SITES: readonly string[] = [
  'musinsa.com',
  '29cm.co.kr',
  'a-rt.com',
  'ssg.com',
  'lotteon.com',
  'lotteimall.com',
  'gsshop.com',
  'ssfshop.com',
  'thehyundai.com',
  'hmall.com',
  'fashionplus.co.kr',
  'galleria.co.kr',
  'lfmall.co.kr',
  'nike.com',
  'gmarket.co.kr',
  'auction.co.kr',
  'coupang.com',
  '11st.co.kr',
  'naver.com',
  'okcashbag.com',
  // 나머지 소싱처(2026-10-24 — 모든 소싱처가 껐다 켜도·재부팅 뒤에도 로그인을 유지하도록)
  'wconcept.co.kr',
  'elandmall.com',
  'elandmall.co.kr',
  'kolonmall.com',
  'arcteryx.co.kr',
  'kasina.co.kr',
  'bunjang.co.kr',
  'leekorea.co.kr',
  'wackywilly.co.kr',
  'esmplus.com',
  'gmarket.com',
  'shoemarker.co.kr',
  'samsungfashion.com'
]

const PAY_HOST_RE = /(^|\.)(pay|pays|payment|payments)[.-]/

/** 이 호스트의 쿠키를 보관해도 되는가 */
export function isSnapshotHost(host: string): boolean {
  const h = host.replace(/^\./, '').toLowerCase()
  if (!h || PAY_HOST_RE.test(h)) return false
  return SNAPSHOT_SITES.some((d) => h === d || h.endsWith(`.${d}`))
}

/**
 * 쿠키가 너무 크면 보관하지 않는다. 사이트가 리다이렉트 반복 등으로 쿠키를 계속 불리면 서버가
 * "400 Request Header Or Cookie Too Large" 로 사이트 전체를 막는데(H몰, 2026-10-24), 그런 쿠키를
 * 보관했다가 되살리면 앱을 다시 켜도 계속 막힌다. 쿠키 하나·같은 호스트 합계에 상한을 둔다
 */
export const MAX_COOKIE_CHARS = 4096
export const MAX_HOST_CHARS = 6000

/** 보관하는 쿠키 한 개(저장소에 쓸 때 필요한 것만) */
export interface SnapCookie {
  name: string
  value: string
  /** host-only 라 점 없는 호스트 그대로 */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  savedAt: number
}

/** 보관 대상인가: 로그인 사이트의 host-only 세션 쿠키 */
export function isSnapshotCookie(c: Cookie): boolean {
  return !!c.session && !!c.hostOnly && !!c.domain && isSnapshotHost(c.domain)
}

function keyOf(c: { domain?: string; path?: string; name: string }): string {
  return `${c.domain ?? ''}|${c.path ?? '/'}|${c.name}`
}

/** 이 호스트로 가는 요청에 실리는 쿠키인가(host-only 는 같은 호스트, 도메인 쿠키는 그 도메인의 하위 호스트 모두) */
export function cookieAppliesToHost(c: Pick<Cookie, 'domain' | 'hostOnly'>, host: string): boolean {
  const d = (c.domain ?? '').toLowerCase()
  if (!d) return false
  if (c.hostOnly || !d.startsWith('.')) return d === host.toLowerCase()
  const bare = d.slice(1)
  return host.toLowerCase() === bare || host.toLowerCase().endsWith(d)
}

/** 쿠키가 온 호스트·경로로 되돌아갈 URL(set 은 url 을 요구한다) */
function urlOf(c: Pick<SnapCookie, 'domain' | 'path' | 'secure'>): string {
  return `${c.secure ? 'https' : 'http'}://${c.domain}${c.path || '/'}`
}

/** 이 모듈이 쿠키 저장소에서 쓰는 부분만(테스트에서 대역으로 갈아 끼운다) */
export interface SnapshotJar {
  on(
    event: 'changed',
    listener: (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void
  ): unknown
  get(filter: Record<string, unknown>): Promise<Cookie[]>
  set(details: CookiesSetDetails): Promise<void>
}

/** 파일 입출력(암호화 포함). null 이면 읽을 것이 없거나 읽을 수 없다 */
export interface SnapshotIo {
  read(): string | null
  /** 쓰지 못했으면(암호화 불가 등) false. 예외도 실패로 본다 — 실패한 변경은 다음 flush 에서 다시 쓴다 */
  write(text: string): boolean | void
}

export interface CookieSnapshotDeps {
  now?: () => number
  keepDays?: number
  /** 쓰기를 모아서 하게 하는 타이머(테스트에서 즉시 실행으로 대체) */
  schedule?: (fn: () => void, ms: number) => void
  onError?: (what: string) => void
}

export class CookieSnapshot {
  private readonly entries = new Map<string, SnapCookie>()
  private dirty = false
  private pending = false

  constructor(
    private readonly io: SnapshotIo,
    private readonly deps: CookieSnapshotDeps = {}
  ) {
    this.load()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private keepMs(): number {
    return (this.deps.keepDays ?? SNAPSHOT_KEEP_DAYS) * 24 * 60 * 60 * 1000
  }

  private load(): void {
    let text: string | null = null
    try {
      text = this.io.read()
    } catch {
      this.deps.onError?.('읽기')
      return
    }
    if (!text) return
    try {
      const list: unknown = JSON.parse(text)
      if (!Array.isArray(list)) return
      for (const raw of list as SnapCookie[]) {
        if (!raw || typeof raw.name !== 'string' || typeof raw.value !== 'string') continue
        if (typeof raw.domain !== 'string' || typeof raw.savedAt !== 'number') continue
        this.entries.set(keyOf(raw), raw)
      }
    } catch {
      this.deps.onError?.('해석')
    }
  }

  size(): number {
    return this.entries.size
  }

  /** 쿠키 변경 한 건을 반영한다(보관 대상이 아니면 무시) */
  track(cookie: Cookie, removed: boolean, cause: string): void {
    if (!cookie.domain || !isSnapshotHost(cookie.domain)) return
    const key = keyOf(cookie)
    if (removed) {
      // 같은 쿠키를 새 값으로 덮어쓰는 중의 제거는 뒤따르는 추가 이벤트가 처리한다
      if (cause === 'overwrite') return
      if (this.entries.delete(key)) this.markDirty()
      return
    }
    if (!isSnapshotCookie(cookie)) return
    if (cookie.name.length + cookie.value.length > MAX_COOKIE_CHARS) {
      // 작은 값이 큰 값으로 바뀐 경우, 옛 작은 값이 다음 실행에서 되살아나지 않게 보관본에서도 뺀다
      if (this.entries.delete(key)) this.markDirty()
      return
    }
    const prev = this.entries.get(key)
    if (prev && prev.value === cookie.value) return
    this.entries.set(key, {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? '/',
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      savedAt: this.now()
    })
    this.markDirty()
  }

  /** 저장소에 이미 있는 보관 대상 쿠키를 모은다(앱을 켜 둔 채 로그인한 쿠키를 놓치지 않게) */
  async absorb(jar: SnapshotJar): Promise<void> {
    for (const c of await jar.get({})) this.track(c, false, 'explicit')
  }

  /**
   * 보관한 쿠키 중 저장소에 없는 것만 만료를 얹어 되살린다. 되살린 개수를 돌려준다.
   * 사이트가 이미 새 값을 준 쿠키(저장소에 있는 것)는 덮어쓰지 않는다
   */
  async restore(jar: SnapshotJar): Promise<number> {
    const now = this.now()
    const present = await jar.get({})
    const have = new Set(present.map((c) => keyOf(c)))
    let restored = 0
    // 호스트별 합계(보관본 + 이미 저장소에 있는 그 호스트로 가는 쿠키)가 상한을 넘으면 그 호스트는 통째로 되살리지 않고
    // 보관본에서도 뺀다. 요청 머리글에는 저장소의 영속 쿠키·상위 도메인 쿠키도 함께 실리기 때문이다
    const hostTotal = new Map<string, number>()
    for (const c of this.entries.values()) {
      if (!hostTotal.has(c.domain)) {
        let n = 0
        for (const p of present) if (cookieAppliesToHost(p, c.domain)) n += p.name.length + p.value.length
        hostTotal.set(c.domain, n)
      }
    }
    // 이미 저장소에 있는 쿠키(앞선 실행에서 되살아나 영속이 된 것 포함)는 위에서 이미 셌으니 다시 더하지 않는다
    for (const [key, c] of this.entries) {
      if (have.has(key)) continue
      hostTotal.set(c.domain, (hostTotal.get(c.domain) ?? 0) + c.name.length + c.value.length)
    }
    for (const [key, c] of [...this.entries]) {
      const expiresAt = c.savedAt + this.keepMs()
      if (expiresAt <= now || c.name.length + c.value.length > MAX_COOKIE_CHARS) {
        this.entries.delete(key)
        this.markDirty()
        continue
      }
      if ((hostTotal.get(c.domain) ?? 0) > MAX_HOST_CHARS) {
        this.entries.delete(key)
        this.markDirty()
        continue
      }
      if (have.has(key)) continue
      try {
        // 앞선 await 동안 사이트·확장이 이 쿠키를 새로 줬을 수 있으니 쓰기 직전에 한 번 더 본다
        const now2 = await jar.get({ url: urlOf(c), name: c.name })
        if (now2.some((x) => keyOf(x) === key)) continue
        await jar.set({
          url: urlOf(c),
          name: c.name,
          value: c.value,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
          expirationDate: Math.floor(expiresAt / 1000)
        })
        restored++
      } catch {
        this.deps.onError?.(c.name)
      }
    }
    return restored
  }

  /** 아직 쓰지 않은 변경이 있으면 바로 쓴다(종료 직전·시험용) */
  flush(): void {
    this.pending = false
    if (!this.dirty) return
    try {
      // 쓰기에 성공했을 때만 '저장됨'으로 본다 — 실패·암호화 불가면 종료 직전 flush 가 다시 시도한다
      if (this.io.write(JSON.stringify([...this.entries.values()])) !== false) this.dirty = false
    } catch {
      this.deps.onError?.('쓰기')
    }
  }

  private markDirty(): void {
    this.dirty = true
    if (this.pending) return
    this.pending = true
    const run = (): void => this.flush()
    if (this.deps.schedule) this.deps.schedule(run, 3000)
    else setTimeout(run, 3000).unref?.()
  }
}

/**
 * 파티션 이름 → 파일 이름. 경로 문자와 한글 등은 '_' 로 바꿔 읽기 쉬운 앞부분을 만들고,
 * 원래 이름의 해시를 붙여 서로 다른 프로필(무신사_a·무신사_b)이 같은 파일로 겹치지 않게 한다
 */
export function snapshotFileName(partition: string): string {
  const readable = partition.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_')
  const hash = createHash('sha1').update(partition).digest('hex').slice(0, 10)
  return `${readable}-${hash}.bin`
}

/** 시작 때 복원이 끝나기를 기다릴 수 있게, 세션별로 복원 약속을 둔다 */
const ready = new WeakMap<object, Promise<void>>()
const live = new Set<CookieSnapshot>()

/** 이 세션의 쿠키 복원이 진행 중이면 그 약속. 없거나 끝났으면 null */
export function cookieSnapshotReady(ses: object): Promise<void> | null {
  return ready.get(ses) ?? null
}

/** 종료 직전에 모든 파티션의 보관본을 바로 쓴다 */
export function flushCookieSnapshots(): void {
  for (const s of live) s.flush()
}

/** 한 파티션에 보관·복원을 건다. 같은 세션에 두 번 걸지 않는다 */
export function installCookieSnapshot(
  ses: { cookies: SnapshotJar },
  io: SnapshotIo,
  deps: CookieSnapshotDeps = {}
): CookieSnapshot {
  const snap = new CookieSnapshot(io, deps)
  live.add(snap)
  ses.cookies.on('changed', (_e, cookie, cause, removed) => snap.track(cookie, removed, cause))
  const job = snap
    .restore(ses.cookies)
    .then(async (n) => {
      // 되살린 뒤에 저장소를 훑어, 켜 둔 채 로그인한 쿠키도 보관본에 넣는다
      await snap.absorb(ses.cookies)
      if (n) console.log(`로그인 쿠키 ${n}개 복원`)
    })
    .catch(() => deps.onError?.('복원'))
    .finally(() => {
      if (ready.get(ses) === job) ready.delete(ses)
    })
  ready.set(ses, job)
  return snap
}

/**
 * 해시 이름으로 바꾸기 전(15:47 이전 빌드)에 쓰던 파일 이름. 영문·숫자 이름만 돌려준다 —
 * 한글 등이 섞인 이름은 서로 다른 프로필이 같은 파일로 겹쳤을 수 있어 다른 계정 쿠키가 섞이므로 쓰지 않는다
 */
export function legacySnapshotFileName(partition: string): string | null {
  // 옛 규칙은 ':' 등을 '_' 로 바꿔서 'a:b' 와 'a_b' 가 같은 파일이 됐다. 변환이 ':' 한 개(persist: 뒤)뿐이고 '_' 가 없는 이름만
  // 원래 이름이 하나로 정해지므로 그런 이름만 이어받는다
  if (!/^persist:ws\d+-[A-Za-z0-9.-]+$/.test(partition)) return null
  return `${partition.replace(/[^A-Za-z0-9_.-]/g, '_')}.bin`
}
