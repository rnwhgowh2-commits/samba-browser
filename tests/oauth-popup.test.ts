// 로그인 팝업은 opener 가 유지되는 별도 창으로 연다 — 카카오 로그인 주소만 대상이다

import { describe, it, expect } from 'vitest'
import { needsOpenerPopup } from '../src/main/browser/oauth-popup'

describe('needsOpenerPopup', () => {
  it('카카오 로그인 호스트는 별도 창으로 연다', () => {
    expect(
      needsOpenerPopup(
        'https://kauth.kakao.com/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fwww.okcashbag.com%2Flogin%2Foauth%2Fkakao%2Fcallback&response_type=code'
      )
    ).toBe(true)
    expect(needsOpenerPopup('https://accounts.kakao.com/login')).toBe(true)
  })

  it('다른 사이트·비슷한 이름·잘못된 주소는 지금처럼 탭으로 연다', () => {
    expect(needsOpenerPopup('https://www.okcashbag.com/login')).toBe(false)
    expect(needsOpenerPopup('https://kauth.kakao.com.evil.com/oauth')).toBe(false)
    expect(needsOpenerPopup('https://notkauth.kakao.com/')).toBe(false)
    expect(needsOpenerPopup('https://www.kakao.com/')).toBe(false)
    expect(needsOpenerPopup('not a url')).toBe(false)
  })
})
