// 로그인 사이트 host-only 세션 쿠키 보관 — 모으기만 하고 시작 때 한 번만 되살린다

import { describe, it, expect } from 'vitest'
import type { Cookie, CookiesSetDetails } from 'electron'
import {
  CookieSnapshot,
  MAX_COOKIE_CHARS,
  MAX_HOST_CHARS,
  SNAPSHOT_KEEP_DAYS,
  installCookieSnapshot,
  isSnapshotHost,
  cookieAppliesToHost,
  legacySnapshotFileName,
  snapshotFileName,
  cookieSnapshotReady,
  type SnapshotIo,
  type SnapshotJar
} from '../src/main/browser/session-cookie-snapshot'

const DAY = 24 * 60 * 60 * 1000

function cookie(over: Partial<Cookie> = {}): Cookie {
  return {
    name: 'accessToken',
    value: 'opaque-1',
    domain: 'www.lfmall.co.kr',
    path: '/',
    secure: true,
    httpOnly: true,
    session: true,
    hostOnly: true,
    sameSite: 'lax',
    ...over
  } as Cookie
}

function memoryIo(initial: string | null = null): SnapshotIo & { text: string | null; writes: number } {
  const io = {
    text: initial,
    writes: 0,
    read: () => io.text,
    write: (t: string) => {
      io.text = t
      io.writes++
    }
  }
  return io
}

type Listener = (e: unknown, c: Cookie, cause: string, removed: boolean) => void

function fakeJar(existing: Cookie[] = []): SnapshotJar & {
  sets: CookiesSetDetails[]
  fire: (c: Cookie, cause: string, removed: boolean) => void
} {
  let listener: Listener | null = null
  const jar = {
    sets: [] as CookiesSetDetails[],
    on: (_ev: 'changed', l: Listener) => {
      listener = l
    },
    get: async () => existing,
    set: async (d: CookiesSetDetails) => {
      jar.sets.push(d)
    },
    fire: (c: Cookie, cause: string, removed: boolean) => listener?.({}, c, cause, removed)
  }
  return jar as never
}

const immediate = { schedule: (fn: () => void) => fn() }

describe('isSnapshotHost', () => {
  it('로그인 사이트와 그 하위 주소만 허용한다', () => {
    expect(isSnapshotHost('www.lfmall.co.kr')).toBe(true)
    expect(isSnapshotHost('.naver.com')).toBe(true)
    expect(isSnapshotHost('hi.thehyundai.com')).toBe(true)
  })

  it('이름만 비슷한 다른 도메인·결제 주소는 거른다', () => {
    expect(isSnapshotHost('notlfmall.co.kr')).toBe(false)
    expect(isSnapshotHost('lfmall.co.kr.evil.com')).toBe(false)
    expect(isSnapshotHost('pay.musinsa.com')).toBe(false)
    expect(isSnapshotHost('api.musinsapayments.com')).toBe(false)
    expect(isSnapshotHost('example.com')).toBe(false)
  })
})

describe('CookieSnapshot.track', () => {
  it('host-only 세션 쿠키만 모은다', () => {
    const io = memoryIo()
    const snap = new CookieSnapshot(io, immediate)
    snap.track(cookie(), false, 'explicit')
    snap.track(cookie({ name: 'domainTok', hostOnly: false, domain: '.lfmall.co.kr' }), false, 'explicit')
    snap.track(cookie({ name: 'persistent', session: false }), false, 'explicit')
    snap.track(cookie({ name: 'other', domain: 'www.example.com' }), false, 'explicit')
    expect(snap.size()).toBe(1)
    expect(JSON.parse(io.text!)[0].name).toBe('accessToken')
  })

  it('값이 바뀌면 갱신하고, 지워지면 뺀다(덮어쓰기 중의 제거는 무시)', () => {
    const io = memoryIo()
    const snap = new CookieSnapshot(io, immediate)
    snap.track(cookie(), false, 'explicit')
    snap.track(cookie(), true, 'overwrite')
    expect(snap.size()).toBe(1)
    snap.track(cookie({ value: 'opaque-2' }), false, 'explicit')
    expect(JSON.parse(io.text!)[0].value).toBe('opaque-2')
    snap.track(cookie({ value: 'opaque-2' }), true, 'explicit')
    expect(snap.size()).toBe(0)
    expect(JSON.parse(io.text!)).toEqual([])
  })

  it('같은 값이면 다시 쓰지 않는다', () => {
    const io = memoryIo()
    const snap = new CookieSnapshot(io, immediate)
    snap.track(cookie(), false, 'explicit')
    snap.track(cookie(), false, 'explicit')
    expect(io.writes).toBe(1)
  })
})

describe('CookieSnapshot.restore', () => {
  it('저장소에 없는 쿠키만 host-only 로 만료를 얹어 되살린다', async () => {
    const now = 1_700_000_000_000
    const io = memoryIo()
    new CookieSnapshot(io, { ...immediate, now: () => now }).track(cookie(), false, 'explicit')
    const jar = fakeJar([])
    const snap = new CookieSnapshot(io, { ...immediate, now: () => now + DAY })
    expect(await snap.restore(jar)).toBe(1)
    expect(jar.sets).toHaveLength(1)
    const d = jar.sets[0]
    expect(d.url).toBe('https://www.lfmall.co.kr/')
    expect(d.name).toBe('accessToken')
    expect('domain' in d).toBe(false) // host-only 유지(도메인 쿠키 복제본을 만들지 않는다)
    expect(d.expirationDate).toBe(Math.floor((now + SNAPSHOT_KEEP_DAYS * DAY) / 1000))
  })

  it('사이트가 이미 준 같은 쿠키는 덮어쓰지 않는다', async () => {
    const now = 1_700_000_000_000
    const io = memoryIo()
    new CookieSnapshot(io, { ...immediate, now: () => now }).track(cookie(), false, 'explicit')
    const jar = fakeJar([cookie({ value: 'newer', session: false })])
    expect(await new CookieSnapshot(io, { ...immediate, now: () => now }).restore(jar)).toBe(0)
    expect(jar.sets).toHaveLength(0)
  })

  it('보관 기간이 지난 쿠키는 되살리지 않고 버린다', async () => {
    const now = 1_700_000_000_000
    const io = memoryIo()
    new CookieSnapshot(io, { ...immediate, now: () => now }).track(cookie(), false, 'explicit')
    const later = now + (SNAPSHOT_KEEP_DAYS + 1) * DAY
    const jar = fakeJar([])
    const snap = new CookieSnapshot(io, { ...immediate, now: () => later })
    expect(await snap.restore(jar)).toBe(0)
    expect(snap.size()).toBe(0)
  })

  it('깨진 파일이면 빈 상태로 시작한다', async () => {
    const snap = new CookieSnapshot(memoryIo('not json'), immediate)
    expect(snap.size()).toBe(0)
    expect(await snap.restore(fakeJar([]))).toBe(0)
  })
})

describe('installCookieSnapshot', () => {
  it('복원이 끝나기 전에는 약속이 있고, 끝나면 사라진다', async () => {
    const io = memoryIo()
    const ses = { cookies: fakeJar([cookie()]) }
    installCookieSnapshot(ses, io, immediate)
    const pending = cookieSnapshotReady(ses)
    expect(pending).not.toBeNull()
    await pending
    await Promise.resolve()
    expect(cookieSnapshotReady(ses)).toBeNull()
    // 켜 둔 채 로그인한 쿠키도 모은다
    expect(JSON.parse(io.text!)[0].name).toBe('accessToken')
  })

  it('실행 중 바뀐 쿠키를 이어서 모은다', () => {
    const io = memoryIo()
    const jar = fakeJar([])
    installCookieSnapshot({ cookies: jar }, io, immediate)
    jar.fire(cookie({ value: 'live' }), 'explicit', false)
    expect(JSON.parse(io.text!)[0].value).toBe('live')
  })
})

describe('snapshotFileName', () => {
  it('경로 문자를 걸러 파일 이름으로 쓴다', () => {
    expect(snapshotFileName('persist:ws1-lfmall-2')).toMatch(/^persist_ws1-lfmall-2-[0-9a-f]{10}\.bin$/)
    const evil = snapshotFileName('../x')
    expect(evil).not.toContain('/')
    expect(evil.startsWith('.')).toBe(false)
  })

  it('한글 등으로만 다른 프로필 이름이 같은 파일로 겹치지 않는다', () => {
    const a = snapshotFileName('persist:ws2-무신사_rnwhgowh')
    const b = snapshotFileName('persist:ws2-롯데온_rnwhgowh')
    expect(a).not.toBe(b)
    expect(snapshotFileName('persist:ws2-무신사_rnwhgowh')).toBe(a)
  })
})

describe('legacySnapshotFileName', () => {
  it('영문·숫자 이름만 옛 파일 이름을 돌려주고, 한글이 섞이면 쓰지 않는다', () => {
    expect(legacySnapshotFileName('persist:ws2-musinsa-1')).toBe('persist_ws2-musinsa-1.bin')
    expect(legacySnapshotFileName('persist:ws2-무신사_rnwhgowh')).toBeNull()
  })
})

describe('너무 큰 쿠키 보호', () => {
  it('쿠키 하나가 상한을 넘으면 보관하지 않는다', () => {
    const snap = new CookieSnapshot(memoryIo(), immediate)
    snap.track(cookie({ value: 'x'.repeat(MAX_COOKIE_CHARS + 1) }), false, 'explicit')
    expect(snap.size()).toBe(0)
  })

  it('같은 호스트 합계가 상한을 넘으면 그 호스트는 되살리지 않고 보관본에서도 뺀다', async () => {
    const now = 1_700_000_000_000
    const io = memoryIo()
    const writer = new CookieSnapshot(io, { ...immediate, now: () => now })
    const each = Math.floor(MAX_HOST_CHARS / 3) + 100
    for (let i = 0; i < 4; i++) {
      writer.track(cookie({ name: `bloat${i}`, value: 'v'.repeat(each) }), false, 'explicit')
    }
    writer.track(cookie({ name: 'ok', domain: 'hi.thehyundai.com', value: 'small' }), false, 'explicit')
    const jar = fakeJar([])
    const snap = new CookieSnapshot(io, { ...immediate, now: () => now })
    expect(await snap.restore(jar)).toBe(1)
    expect(jar.sets.map((d) => d.name)).toEqual(['ok'])
    expect(snap.size()).toBe(1)
  })
})

describe('Codex 리뷰 반영(2026-10-24)', () => {
  it('옛 파일 이름은 충돌 없는 영문 이름만 이어받는다', () => {
    expect(legacySnapshotFileName('persist:ws2-musinsa-1')).toBe('persist_ws2-musinsa-1.bin')
    // ':' 가 더 있거나 '_' 가 든 이름은 다른 이름과 같은 옛 파일이 될 수 있어 이어받지 않는다
    expect(legacySnapshotFileName('persist:shop:a')).toBeNull()
    expect(legacySnapshotFileName('persist:ws2-review_a')).toBeNull()
    expect(legacySnapshotFileName('persist:shop_a')).toBeNull()
  })

  it('복원 중 새로 받은 쿠키는 옛 값으로 덮지 않는다', async () => {
    const now = 1_700_000_000_000
    const io = memoryIo()
    const w = new CookieSnapshot(io, { ...immediate, now: () => now })
    w.track(cookie({ name: 'first', value: 'old1' }), false, 'explicit')
    w.track(cookie({ name: 'second', value: 'old2' }), false, 'explicit')
    const sets: CookiesSetDetails[] = []
    let current: Cookie[] = []
    const jar = {
      on: () => undefined,
      get: async (f: Record<string, unknown>) => (f.name ? current.filter((c) => c.name === f.name) : current),
      set: async (d: CookiesSetDetails) => {
        sets.push(d)
        // 첫 쿠키를 쓰는 동안 확장이 두 번째 쿠키를 새 값으로 줬다
        if (d.name === 'first') current = [...current, cookie({ name: 'second', value: 'new2', session: false })]
      }
    } as unknown as SnapshotJar
    const snap = new CookieSnapshot(io, { ...immediate, now: () => now })
    await snap.restore(jar)
    expect(sets.map((d) => d.name)).toEqual(['first'])
  })

  it('쓰기에 실패하면 저장됨으로 치지 않고 다시 쓴다', () => {
    let fail = true
    const writes: string[] = []
    const io: SnapshotIo = {
      read: () => null,
      write: (t) => {
        if (fail) return false
        writes.push(t)
      }
    }
    const snap = new CookieSnapshot(io, { schedule: () => undefined })
    snap.track(cookie(), false, 'explicit')
    snap.flush()
    expect(writes).toHaveLength(0)
    fail = false
    snap.flush()
    expect(writes).toHaveLength(1)
  })

  it('작은 쿠키가 큰 쿠키로 바뀌면 옛 보관값도 지운다', () => {
    const io = memoryIo()
    const snap = new CookieSnapshot(io, immediate)
    snap.track(cookie({ value: 'small' }), false, 'explicit')
    expect(snap.size()).toBe(1)
    snap.track(cookie({ value: 'x'.repeat(MAX_COOKIE_CHARS + 1) }), false, 'explicit')
    expect(snap.size()).toBe(0)
  })

  it('저장소에 이미 있는 쿠키 크기도 호스트 합계에 넣는다', async () => {
    const now = 1_700_000_000_000
    const io = memoryIo()
    const w = new CookieSnapshot(io, { ...immediate, now: () => now })
    w.track(cookie({ name: 'a', value: 'v'.repeat(3500) }), false, 'explicit')
    const jar = fakeJar([cookie({ name: 'existing', value: 'e'.repeat(3500), session: false, hostOnly: false, domain: '.lfmall.co.kr' })])
    const snap = new CookieSnapshot(io, { ...immediate, now: () => now })
    expect(await snap.restore(jar)).toBe(0)
    expect(snap.size()).toBe(0)
  })

  it('cookieAppliesToHost', () => {
    expect(cookieAppliesToHost({ domain: 'www.lfmall.co.kr', hostOnly: true }, 'www.lfmall.co.kr')).toBe(true)
    expect(cookieAppliesToHost({ domain: 'www.lfmall.co.kr', hostOnly: true }, 'm.lfmall.co.kr')).toBe(false)
    expect(cookieAppliesToHost({ domain: '.lfmall.co.kr', hostOnly: false }, 'www.lfmall.co.kr')).toBe(true)
    expect(cookieAppliesToHost({ domain: '.lfmall.co.kr', hostOnly: false }, 'evil-lfmall.co.kr')).toBe(false)
  })
})

describe('Codex 최종 점검 반영(2026-10-24)', () => {
  it('이미 저장소에 있는 쿠키는 호스트 합계에 두 번 세지 않는다', async () => {
    const now = 1_700_000_000_000
    const io = memoryIo()
    const w = new CookieSnapshot(io, { ...immediate, now: () => now })
    w.track(cookie({ name: 'A', value: 'a'.repeat(3500) }), false, 'explicit')
    w.track(cookie({ name: 'B', value: 'b'.repeat(500) }), false, 'explicit')
    // 앞선 실행에서 A 가 되살아나 이미 저장소에 있다(영속). 합계는 A 3,500 + B 500 = 4,000 이라 상한 안
    const jar = fakeJar([cookie({ name: 'A', value: 'a'.repeat(3500), session: false })])
    const snap = new CookieSnapshot(io, { ...immediate, now: () => now })
    expect(await snap.restore(jar)).toBe(1)
    expect(jar.sets.map((d) => d.name)).toEqual(['B'])
  })
})
