import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabManager } from '../src/main/browser/tab-manager'
const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    snapshot: vi.fn(),
    signedInHint: vi.fn(),
    click: vi.fn(async () => 'ok'),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))
import { loginWithNaverSession } from '../src/main/agent/login-social'
let url: string
const tab = { id: 'site', view: { webContents: { getURL: () => url } } } as unknown as Tab
const navigate = vi.fn(async (_id: string, to: string) => {
  url = to
})
const tabs = { navigate } as unknown as TabManager
beforeEach(() => {
  vi.clearAllMocks()
  url = 'https://www.lemouton.co.kr/member/login.html'
  pageBridge.snapshot.mockResolvedValue({ elements: [] })
  pageBridge.signedInHint.mockResolvedValue({ signedIn: false })
})
describe('네이버 세션 로그인', () => {
  it('기존 회원 폼 대신 네이버 버튼만 한 번 누른다', async () => {
    pageBridge.snapshot.mockResolvedValue({
      elements: [
        { id: 1, text: '기존 회원 로그인', isSecret: false },
        { id: 2, text: '네이버로 로그인', isSecret: false }
      ]
    })
    expect(await loginWithNaverSession(tabs, tab)).toContain('submitted: Naver SSO')
    expect(pageBridge.click).toHaveBeenCalledExactlyOnceWith(tab, 2)
    expect(navigate).not.toHaveBeenCalled()
  })
  it('버튼이 없으면 알려진 로그인 주소에서 찾고 없어도 비밀번호 폼으로 돌아가지 않는다', async () => {
    expect(await loginWithNaverSession(tabs, tab)).toContain('Naver SSO button missing')
    expect(navigate).toHaveBeenCalledWith('site', 'https://www.lemouton.co.kr/member/login.html')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })
  it('로그인 URL이 홈으로 리디렉션되면 실제 보호된 회원 페이지를 확인한다', async () => {
    pageBridge.snapshot.mockResolvedValue({
      elements: [],
      text: '감사합니다. 일반회원 회원이십니다.'
    })
    expect(await loginWithNaverSession(tabs, tab)).toContain('verified member page')
    expect(url).toBe('https://www.lemouton.co.kr/myshop/index.html')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })
  it('이미 로그인되었으면 세션을 보존하고 다른 도메인 버튼은 누르지 않는다', async () => {
    pageBridge.signedInHint.mockResolvedValue({ signedIn: true, weak: false })
    expect(await loginWithNaverSession(tabs, tab)).toContain('already signed in')
    expect(navigate).not.toHaveBeenCalled()
    pageBridge.signedInHint.mockResolvedValue({ signedIn: false })
    navigate.mockImplementationOnce(async () => {
      url = 'https://other.example/'
    })
    expect(await loginWithNaverSession(tabs, tab)).toContain('page moved to another site')
    expect(pageBridge.click).not.toHaveBeenCalled()
  })
})
