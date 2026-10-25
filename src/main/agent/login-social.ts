import type { Tab } from '../browser/tab-manager'
import type { TabManager } from '../browser/tab-manager'
import { pageBridge } from '../browser/page-bridge'
import { knownLoginUrl } from '../../shared/site-rules'
import { normalizeHost } from '../../shared/host'
import { sameRegistrableDomain, isSecurePageUrl } from '../vault/access-gate'

/** 현재 프로필의 네이버 세션을 이용한다. 비밀번호 채움·기본 회원 로그인으로 돌아가지 않는다. */
export async function loginWithNaverSession(tabs: TabManager, tab: Tab): Promise<string> {
  const host = normalizeHost(tab.view.webContents.getURL())
  let verifiedSession = false
  const readButton = async (): Promise<number | undefined> => {
    const url = tab.view.webContents.getURL()
    if (!isSecurePageUrl(url) || !sameRegistrableDomain(host, normalizeHost(url))) return undefined
    const snap = await pageBridge.snapshot(tab)
    // 르무통은 로그인 상태에서 로그인 URL을 홈으로 보낸다. 보호된 마이페이지 본문으로 확인한다.
    verifiedSession =
      host === 'lemouton.co.kr' &&
      new URL(url).pathname === '/myshop/index.html' &&
      /회원이십니다/.test(snap.text ?? '')
    return snap.elements.find(
      (e) =>
        !e.isSecret &&
        /네이버로 로그인|네이버\s*(간편\s*)?로그인|naver\s*(login|sign in)/i.test(e.text)
    )?.id
  }
  let button = await readButton()
  if (verifiedSession)
    return 'already signed in: verified member page; existing site session preserved'
  if (button === undefined) {
    const hint = await pageBridge.signedInHint(tab)
    if (hint.signedIn && !hint.weak) return 'already signed in: existing site session preserved'
    const url = knownLoginUrl(host)
    if (!url) return 'fields not found: open the site Naver login page'
    await tabs.navigate(tab.id, url)
    await pageBridge.waitForLoad(tab)
    button = await readButton()
    if (button === undefined && host === 'lemouton.co.kr') {
      const current = tab.view.webContents.getURL()
      if (!isSecurePageUrl(current) || !sameRegistrableDomain(host, normalizeHost(current))) {
        return 'refused: page moved to another site'
      }
      await tabs.navigate(tab.id, 'https://www.lemouton.co.kr/myshop/index.html')
      await pageBridge.waitForLoad(tab)
      button = await readButton()
      if (verifiedSession)
        return 'already signed in: verified member page; existing site session preserved'
    }
  }
  if (button === undefined)
    return 'fields not found: Naver SSO button missing; no password was filled'
  const result = await pageBridge.click(tab, button)
  if (result !== 'ok') return result
  await pageBridge.waitForLoad(tab)
  return 'submitted: Naver SSO using the current profile session; verify the site account and order page, or inspect the Naver popup if still open'
}
