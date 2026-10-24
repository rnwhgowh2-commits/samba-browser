// 사이트별 쿠키 삭제 — 그 사이트 쿠키만 지우고 다른 사이트는 건드리지 않는다

import { describe, it, expect } from 'vitest'
import type { Cookie, Session } from 'electron'
import {
  clearSiteCookies,
  clearSiteCookiesIn,
  cookieBelongsToSite,
  isSafeProfileName,
  setCookieClearTarget,
  type ClearableJar
} from '../src/main/browser/cookie-clear'

function c(domain: string, name: string, over: Partial<Cookie> = {}): Cookie {
  return { name, value: 'v', domain, path: '/', secure: true, httpOnly: false, session: true, hostOnly: false, ...over } as Cookie
}

function jarOf(list: Cookie[]): ClearableJar & { removed: string[] } {
  const jar = {
    removed: [] as string[],
    get: async () => list,
    remove: async (url: string, name: string) => {
      jar.removed.push(`${url}|${name}`)
    }
  }
  return jar
}

describe('cookieBelongsToSite', () => {
  it('등록 도메인과 하위 호스트만 그 사이트다', () => {
    expect(cookieBelongsToSite({ domain: '.hmall.com' }, 'hmall.com')).toBe(true)
    expect(cookieBelongsToSite({ domain: 'www.hmall.com' }, 'hmall.com')).toBe(true)
    expect(cookieBelongsToSite({ domain: 'nothmall.com' }, 'hmall.com')).toBe(false)
    expect(cookieBelongsToSite({ domain: 'hmall.com.evil.com' }, 'hmall.com')).toBe(false)
  })
})

describe('clearSiteCookiesIn', () => {
  it('그 사이트 쿠키만 지우고 개수를 돌려준다', async () => {
    const jar = jarOf([c('.hmall.com', 'a'), c('www.hmall.com', 'b', { hostOnly: true }), c('.naver.com', 'n')])
    expect(await clearSiteCookiesIn(jar, 'hmall.com')).toEqual({ removed: 2, failed: 0 })
    expect(jar.removed).toEqual(['https://hmall.com/|a', 'https://www.hmall.com/|b'])
  })

  it('하나가 실패해도 나머지는 지운다', async () => {
    const list = [c('.hmall.com', 'a'), c('.hmall.com', 'b')]
    let n = 0
    const jar: ClearableJar = {
      get: async () => list,
      remove: async () => {
        if (n++ === 0) throw new Error('x')
      }
    }
    expect(await clearSiteCookiesIn(jar, 'hmall.com')).toEqual({ removed: 1, failed: 1 })
  })
})

describe('clearSiteCookies 입구', () => {
  const fakeSession = (list: Cookie[]) => ({ cookies: jarOf(list) }) as unknown as Session

  it('준비 전이거나 입력이 나쁘면 거절한다', async () => {
    setCookieClearTarget(null)
    expect(await clearSiteCookies({ profile: 'default', host: 'hmall.com' })).toEqual({ ok: false, error: 'not ready' })
    setCookieClearTarget({ sessionFor: () => fakeSession([]) })
    expect(await clearSiteCookies({ profile: '../x', host: 'hmall.com' })).toEqual({ ok: false, error: 'invalid profile' })
    expect(await clearSiteCookies({ profile: 'default', host: 'example.com' })).toEqual({ ok: false, error: 'host not allowed' })
    expect(await clearSiteCookies({ profile: 'default', host: 'pay.musinsa.com' })).toEqual({ ok: false, error: 'host not allowed' })
  })

  it('허용된 사이트는 자동화 쪽 세션에서 지운다', async () => {
    let asked: [string, boolean] | null = null
    setCookieClearTarget({
      sessionFor: (p, a) => {
        asked = [p, a]
        return fakeSession([c('.hmall.com', 'a')])
      }
    })
    expect(await clearSiteCookies({ profile: 'default', host: '.hmall.com' })).toEqual({ ok: true, removed: 1, failed: 0 })
    expect(asked).toEqual(['default', true])
  })
})

describe('isSafeProfileName', () => {
  it('경로 문자를 막는다', () => {
    expect(isSafeProfileName('musinsa-2')).toBe(true)
    expect(isSafeProfileName('무신사_rnwhgowh')).toBe(true)
    expect(isSafeProfileName('a/b')).toBe(false)
    expect(isSafeProfileName('')).toBe(false)
  })
})
