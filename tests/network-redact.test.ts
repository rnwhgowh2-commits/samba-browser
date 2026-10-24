import { describe, it, expect } from 'vitest'
import {
  MASKED,
  clip,
  isSensitiveEndpoint,
  isTextualMime,
  redactBody,
  redactHeaders,
  redactUrl
} from '../src/shared/network-redact'

describe('redactHeaders', () => {
  it('쿠키·인증·토큰 헤더의 값은 가리고 이름은 남긴다', () => {
    const out = redactHeaders({
      Cookie: 'sid=abc',
      Authorization: 'Bearer xyz',
      'X-Auth-Token': 't',
      'x-csrf-token': 'c',
      Accept: 'application/json',
      Referer: 'https://shop.example/p/1'
    })
    expect(out.Cookie).toBe(MASKED)
    expect(out.Authorization).toBe(MASKED)
    expect(out['X-Auth-Token']).toBe(MASKED)
    expect(out['x-csrf-token']).toBe(MASKED)
    expect(out.Accept).toBe('application/json')
    expect(out.Referer).toBe('https://shop.example/p/1')
  })
  it('헤더가 없으면 빈 객체', () => {
    expect(redactHeaders(undefined)).toEqual({})
  })
})

describe('redactBody', () => {
  it('JSON 은 비밀 키의 값만 가린다(중첩·배열 포함)', () => {
    const body = JSON.stringify({
      goodsNo: 'A1',
      price: 1000,
      user: { password: 'pw1234', loginId: 'abc' },
      list: [{ accessToken: 'tok', name: 'x' }],
      cardNo: '1234-5678',
      cardBenefit: '5% 청구할인'
    })
    const out = JSON.parse(redactBody(body, 'application/json'))
    expect(out.goodsNo).toBe('A1')
    expect(out.price).toBe(1000)
    expect(out.user.password).toBe(MASKED)
    expect(out.user.loginId).toBe('abc')
    expect(out.list[0].accessToken).toBe(MASKED)
    expect(out.list[0].name).toBe('x')
    expect(out.cardNo).toBe(MASKED)
    // 카드 혜택 같은 가격 정보 키는 가리지 않는다
    expect(out.cardBenefit).toBe('5% 청구할인')
  })
  it('폼 본문은 필드 이름으로 가린다', () => {
    const out = redactBody('goodsNo=A1&password=secret&qty=2', 'application/x-www-form-urlencoded')
    expect(out).toContain('goodsNo=A1')
    expect(out).toContain('qty=2')
    expect(out).not.toContain('secret')
  })
  it('글자 속 쿼리 꼴(?accessToken=…, &password=…)도 가린다', () => {
    const out = redactBody(
      '<script>x.open("/api/a?goodsNo=1&accessToken=SECRETQ"); post("id=a&password=PWLOGIN")</script>',
      'text/html'
    )
    expect(out).not.toContain('SECRETQ')
    expect(out).not.toContain('PWLOGIN')
    expect(out).toContain('goodsNo=1')
  })
  it('따옴표가 이스케이프된 token=\\"…\\" 꼴도 가린다', () => {
    const out = redactBody('console.log("hello token=\\"abcdef123456\\"")', 'text/html')
    expect(out).not.toContain('abcdef123456')
  })
  it('글자 속 token: "…" 꼴을 가린다', () => {
    const out = redactBody('var cfg = {token: "abcdef123456", name: "shop"}', 'text/html')
    expect(out).not.toContain('abcdef123456')
    expect(out).toContain('name: "shop"')
  })
})

describe('isSensitiveEndpoint', () => {
  it('로그인·인증 계열은 어떤 방식이든 본문을 싣지 않는다', () => {
    expect(isSensitiveEndpoint('https://a.example/member/login.do')).toBe(true)
    expect(isSensitiveEndpoint('https://a.example/oauth/token')).toBe(true)
    expect(isSensitiveEndpoint('https://a.example/api/pincert/check', 'POST')).toBe(true)
  })
  it('결제·주문은 쓰기 요청일 때만', () => {
    expect(isSensitiveEndpoint('https://a.example/api/order/pay', 'POST')).toBe(true)
    expect(isSensitiveEndpoint('https://a.example/api/payment/benefit', 'GET')).toBe(false)
  })
  it('평범한 상품 API 는 싣는다', () => {
    expect(isSensitiveEndpoint('https://a.example/api/goods/123/options')).toBe(false)
  })
})

describe('redactUrl', () => {
  it('쿼리의 토큰 값을 가린다', () => {
    const out = redactUrl('https://a.example/x?goodsNo=1&accessToken=abc')
    expect(out).toContain('goodsNo=1')
    expect(out).not.toContain('abc')
  })
  it('가릴 게 없으면 그대로', () => {
    expect(redactUrl('https://a.example/x?goodsNo=1')).toBe('https://a.example/x?goodsNo=1')
  })
})

describe('clip / isTextualMime', () => {
  it('길면 자르고 남은 길이를 알린다', () => {
    expect(clip('abcdef', 3)).toBe('abc… [+3 chars]')
    expect(clip('abc', 3)).toBe('abc')
  })
  it('글자 응답만 본문 대상', () => {
    expect(isTextualMime('application/json')).toBe(true)
    expect(isTextualMime('text/html; charset=utf-8')).toBe(true)
    expect(isTextualMime('image/png')).toBe(false)
    expect(isTextualMime(undefined)).toBe(false)
  })
})
