// 사이트별 추가 로그인 단계. 비밀번호·인증번호는 읽거나 보관하지 않는다.
export function elementsOf(text) {
  return [...text.matchAll(/^\[(\d+)\]\s+(\S+)\s+"([^"]*)"/gm)]
    .map((m) => ({ id: Number(m[1]), role: m[2], name: m[3] }))
}

export function needsUser(text) {
  return /법률 약관이 업데이트|계속 진행하시려면.*동의|인증\s*코드|인증번호|8자리\s*코드|verification\s*code|비밀번호가 일치하지|보안문자|captcha/i.test(text)
}

// 두 사이트는 주소가 그대로여도 빈 SPA 셸일 수 있다. 회원 전용 본문까지 확인한다.
export function verifiedMemberPage(text, requiredText) {
  if (/^(error:|no active tab)/i.test(text.trim()) || needsUser(text)) return false
  if (!elementsOf(text).length) return false
  const body = text.split('PAGE TEXT:')[1] ?? ''
  return !!body.trim() && new RegExp(requiredText, 'i').test(body)
}

/** 카카오의 기존 간편로그인 계정만 선택한다. 약관·인증·새 계정은 건드리지 않는다. */
export async function loginWithKakao(site, { call, sleep }, lane) {
  const deadline = Date.now() + 90_000
  const invoke = (name, args = {}) => call(name, args, { lane, retries: 1, timeoutMs: 25_000 })
  await invoke('new_tab', { url: site.relogin.loginUrl, profile: site.profile ?? 'default' })
  let button
  for (let i = 0; i < 6 && !button && Date.now() < deadline; i++) {
    await sleep(2500)
    const text = await invoke('get_page')
    if (/^URL: https:\/\/www\.okcashbag\.com\/(?!login(?:[/?#]|$))/m.test(text) && elementsOf(text).length)
      return { ok: true } // 실제 회원 여부는 호출부가 보호된 포인트 화면으로 재확인한다.
    button = elementsOf(text).find((e) => e.role === 'button' && e.name === '카카오로 계속하기')
  }
  if (!button) return { ok: false, reason: '카카오 로그인 버튼을 찾지 못함' }
  await invoke('click', { id: button.id, label: '카카오로 계속하기' })
  let selected = false
  for (let i = 0; i < 16 && Date.now() < deadline; i++) {
    await sleep(2500)
    const tabs = JSON.parse(await invoke('list_tabs'))
    const popup = tabs.find((t) => t.kind === 'popup' && /^https:\/\/accounts\.kakao\.com\//i.test(t.url ?? ''))
    if (popup) {
      await invoke('switch_tab', { id: popup.id })
      const text = await invoke('get_page')
      if (needsUser(text) || /동의하고 계속|추가 인증/.test(text))
        return { ok: false, needsUser: true, reason: '카카오 약관·추가 인증 확인 필요' }
      const accounts = elementsOf(text).filter((e) => e.role === 'button' && /\S+@\S+/.test(e.name))
      const account = accounts.find((e) => e.name.split(/\s/)[0] === site.relogin.accountEmail)
      if (!selected && account) {
        await invoke('click', { id: account.id, label: '기존 카카오계정으로 로그인' })
        selected = true
      } else if (!selected && accounts.length)
        return { ok: false, needsUser: true, reason: '지정한 카카오계정이 없어 직접 선택 필요' }
      else if (!selected && /새로운 계정으로 로그인|카카오계정.*로그인/.test(text))
        return { ok: false, needsUser: true, reason: '카카오 세션 만료 — 카카오 로그인 필요' }
    }
    const pending = tabs.some((t) => t.kind === 'popup')
    const main = tabs.find((t) => t.kind === 'tab' && /^https:\/\/www\.okcashbag\.com\//.test(t.url ?? ''))
    if (!pending && main && !/\/login(?:[/?#]|$)/.test(main.url)) return { ok: true }
  }
  return { ok: false, reason: '카카오 로그인 완료를 확인하지 못함' }
}

/** 이메일 제출 뒤 늦게 나타나는 나이키 비밀번호 화면을 기다린다. 새 약관은 자동 동의하지 않는다. */
export async function continueNikeLogin(site, { call, sleep }, lane) {
  const deadline = Date.now() + 60_000
  const invoke = (name, args = {}) => call(name, args, { lane, retries: 1, timeoutMs: 25_000 })
  let clicked = false
  for (let i = 0; i < 16 && Date.now() < deadline; i++) {
    await sleep(2500)
    const text = await invoke('get_page')
    if (needsUser(text)) return { ok: false, needsUser: true, reason: '나이키 약관·이메일 인증 확인 필요' }
    if (/^URL: https:\/\/accounts\.nike\.com\//m.test(text)) {
      // 로그인 도구가 이메일을 채웠으나 제출되지 않은 경우에만 버튼을 한 번 누른다.
      const els = elementsOf(text)
      if (!clicked && /name=credential value="[^"\n]+@[^"\n]+"/.test(text)) {
        const btn = els.find((e) => e.role === 'button' && /^(continue|계속)$/i.test(e.name))
        if (btn) {
          await invoke('click', { id: btn.id, label: '나이키 이메일 계속' })
          clicked = true
        }
      }
      if (/\b(password|secret)\b|비밀번호\*/i.test(text)) {
        const result = await invoke('login', site.relogin.accountLabel ? { accountLabel: site.relogin.accountLabel } : {})
        if (!/^submitted|^already signed in/i.test(result))
          return { ok: false, reason: '나이키 비밀번호 단계 로그인 실패' }
        await sleep(2500)
        const after = await invoke('get_page')
        if (needsUser(after))
          return { ok: false, needsUser: true, reason: '나이키 비밀번호 오류·추가 인증 확인 필요' }
        return { ok: true }
      }
    } else if (/^URL: https:\/\/www\.nike\.com\//m.test(text) && !/^URL: [^\n]*\/(?:auth\/)?login/m.test(text))
      return { ok: true }
  }
  return { ok: false, reason: '나이키 다음 로그인 화면을 확인하지 못함' }
}
