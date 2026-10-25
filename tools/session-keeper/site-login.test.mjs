import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loginWithKakao, continueNikeLogin, verifiedMemberPage } from './site-login.mjs'

const sleep = async () => {}
const kakao = { relogin: { loginUrl: 'https://www.okcashbag.com/login', accountEmail: 'owner@example.com' } }
const nike = { relogin: { accountLabel: 'owner@example.com' } }
const snap = (url, body, els = '') => `URL: ${url}\nINTERACTIVE ELEMENTS:\n${els}\nPAGE TEXT:\n${body}`
const nikeLookup = snap('https://accounts.nike.com/lookup', '이메일 입력',
  '[3] textbox "이메일*" name=credential value="owner@example.com"\n[7] button "continue"')

test('주소와 빈 SPA 셸만으로 로그인 성공 처리하지 않는다', () => {
  assert.equal(verifiedMemberPage(snap('https://example.com/profile', ''), '프로필'), false)
  assert.equal(verifiedMemberPage(snap('https://example.com/profile', 'Quick 메뉴'), '포인트 내역'), false)
  assert.equal(verifiedMemberPage('error: page did not respond', '로그아웃'), false)
  assert.equal(verifiedMemberPage(snap('https://example.com/profile', '계정 설정 로그아웃', '[1] button "로그아웃"'), '로그아웃'), true)
  assert.equal(verifiedMemberPage(snap('https://example.com/profile', '로그아웃'), '로그아웃'), false)
  assert.equal(verifiedMemberPage(snap('https://accounts.nike.com/challenge-code', '법률 약관이 업데이트 로그아웃'), '로그아웃'), false)
})

test('카카오는 지정된 기존 계정만 선택하고 팝업 종료를 기다린다', async () => {
  const calls = []
  let chosen = false
  const call = async (name, args) => {
    calls.push([name, args])
    if (name === 'get_page') return calls.some(([n]) => n === 'switch_tab')
      ? snap('https://accounts.kakao.com/login/simple', '계정 선택', '[8] button "owner@example.com 사용자"')
      : snap(kakao.relogin.loginUrl, '시작하기', '[2] button "카카오로 계속하기"')
    if (name === 'click' && args.id === 8) chosen = true
    if (name === 'list_tabs') return JSON.stringify(chosen
      ? [{ kind: 'tab', url: 'https://www.okcashbag.com/' }]
      : [{ id: 'p', kind: 'popup', url: 'https://accounts.kakao.com/login/simple' }])
    return 'ok'
  }
  assert.deepEqual(await loginWithKakao(kakao, { call, sleep }, 'lane'), { ok: true })
  assert.deepEqual(calls.filter(([n]) => n === 'click').map(([, a]) => a.id), [2, 8])
  assert.equal(calls.some(([n]) => /login|type|fill_secret/.test(n)), false)
})

test('다른 카카오계정을 대신 고르거나 비밀번호를 제출하지 않는다', async () => {
  const clicks = []
  const call = async (name, args) => {
    if (name === 'get_page') return clicks.length
      ? snap('https://accounts.kakao.com/login/simple', '계정 선택', '[8] button "other@example.com 사용자"')
      : '[2] button "카카오로 계속하기"'
    if (name === 'click') clicks.push(args.id)
    if (name === 'list_tabs') return JSON.stringify([{ id: 'p', kind: 'popup', url: 'https://accounts.kakao.com/login/simple' }])
    return 'ok'
  }
  const result = await loginWithKakao(kakao, { call, sleep }, 'lane')
  assert.equal(result.needsUser, true)
  assert.deepEqual(clicks, [2])
})

test('이미 로그인되어 홈으로 이동한 경우 회원 화면 재확인 단계로 넘긴다', async () => {
  const calls = []
  const call = async (name) => {
    calls.push(name)
    return name === 'get_page'
      ? snap('https://www.okcashbag.com/', '포인트', '[1] button "메뉴"') : 'ok'
  }
  assert.deepEqual(await loginWithKakao(kakao, { call, sleep }, 'lane'), { ok: true })
  assert.deepEqual(calls, ['new_tab', 'get_page'])
})

test('카카오 약관 화면은 자동으로 동의하지 않는다', async () => {
  let popup = false
  const call = async (name) => {
    if (name === 'get_page') return popup ? '동의하고 계속' : '[2] button "카카오로 계속하기"'
    if (name === 'list_tabs') {
      popup = true
      return JSON.stringify([{ id: 'p', kind: 'popup', url: 'https://accounts.kakao.com/login' }])
    }
    return 'ok'
  }
  assert.equal((await loginWithKakao(kakao, { call, sleep }, 'lane')).needsUser, true)
})

test('나이키 이메일 계속은 한 번만 누르고 늦은 비밀번호 화면에서 저장 로그인한다', async () => {
  let reads = 0
  const calls = []
  const call = async (name, args) => {
    calls.push([name, args])
    if (name === 'get_page') return ++reads < 3 ? nikeLookup
      : snap('https://accounts.nike.com/login', '비밀번호*', '[9] secret "비밀번호*" name=password')
    if (name === 'login') return 'submitted: check the page'
    return 'ok'
  }
  assert.deepEqual(await continueNikeLogin(nike, { call, sleep }, 'lane'), { ok: true })
  assert.equal(calls.filter(([n]) => n === 'click').length, 1)
  assert.equal(calls.filter(([n]) => n === 'login').length, 1)
  assert.deepEqual(calls.find(([n]) => n === 'login')[1], { accountLabel: 'owner@example.com' })
})

for (const body of ['법률 약관이 업데이트되었습니다', '이메일 인증 코드를 입력하세요', '휴대폰으로 전송된 8자리 코드를 입력하세요', '비밀번호가 일치하지 않습니다.']) {
  test(`나이키 사용자 확인에서 중단: ${body}`, async () => {
    const calls = []
    const call = async (name) => {
      calls.push(name)
      return snap('https://accounts.nike.com/challenge-code', body)
    }
    assert.equal((await continueNikeLogin(nike, { call, sleep }, 'lane')).needsUser, true)
    assert.deepEqual(calls, ['get_page'])
  })
}

test('나이키 제출 응답 뒤 비밀번호 오류가 나오면 재제출하지 않고 탭을 남긴다', async () => {
  let submitted = false
  let logins = 0
  const call = async (name) => {
    if (name === 'login') { submitted = true; logins++; return 'submitted: check the page' }
    return snap('https://accounts.nike.com/challenge', submitted ? '비밀번호가 일치하지 않습니다.' : '비밀번호*')
  }
  const result = await continueNikeLogin(nike, { call, sleep }, 'lane')
  assert.equal(result.ok, false)
  assert.equal(result.needsUser, true)
  assert.equal(logins, 1)
})

test('나이키 로그인 응답 오류를 성공으로 처리하지 않는다', async () => {
  const call = async (name) => name === 'get_page'
    ? snap('https://accounts.nike.com/login', '비밀번호*') : 'account not found'
  assert.equal((await continueNikeLogin(nike, { call, sleep }, 'lane')).ok, false)
})

test('두 사이트가 실제 회원 본문을 요구하고 기존 시도 한도를 유지한다', () => {
  const cfg = JSON.parse(readFileSync(new URL('./sites.json', import.meta.url), 'utf8'))
  for (const id of ['OKCASHBACK', 'Nike']) {
    const site = cfg.sites.find((s) => s.id === id)
    assert.ok(site.probe.requiredText)
    assert.ok(site.relogin)
    assert.deepEqual(site.budget, { perDay: 2, minGapMin: 180, maxConsecutiveFails: 2 })
  }
  const nike = cfg.sites.find((s) => s.id === 'Nike')
  assert.equal(verifiedMemberPage(snap('https://www.nike.com/kr/member/profile',
    '프로필 주문 위시리스트 설정 회원 나이키 멤버 가입: 2025년 5월', '[1] link "현재 페이지 프로필"'), nike.probe.requiredText), true)
  assert.equal(verifiedMemberPage(snap('https://www.nike.com/kr/',
    '프로필 주문 위시리스트 멤버가입', '[1] link "프로필"'), nike.probe.requiredText), false)
})
