// 하네스가 쓰는 프로필(키마스터 라벨과 같은 이름)에 무신사 로그인을 복구한다 — 세션 관리자와 같은 방식(레인 탭 + 앱의 login 도구).
// 사용: node login-harness-profile.mjs <프로필·계정라벨>
// 비밀번호는 앱이 키마스터에서 꺼내 입력한다. 이 스크립트는 값을 보지도 출력하지도 않는다(회원 아이디도 앞 3자만).
import { call, sleep } from '../bridge.mjs'

const label = process.argv[2]
if (!label) {
  console.log('사용법: node login-harness-profile.mjs <라벨>')
  process.exit(2)
}
const lane = 'harness-login-fix'
const tabIdOf = (r) => /tab ([0-9a-f-]{36})/.exec(String(r))?.[1]

async function closeAll() {
  try {
    const tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    for (const t of tabs) await call('close_tab', { id: t.id }, { lane }).catch(() => {})
  } catch {}
}

async function identity() {
  const r = await call('new_tab', { url: 'https://my.musinsa.com/api2/member/v1/my-info', profile: label }, { lane })
  const id = tabIdOf(r)
  let got = ''
  try {
    for (let i = 0; i < 4 && !got; i++) {
      await sleep(i === 0 ? 5000 : 3000)
      const txt = await call('get_page', {}, { lane })
      const m = /"memberId"\s*:\s*"([^"]+)"/.exec(txt)
      if (m) got = m[1]
    }
  } finally {
    if (id) await call('close_tab', { id }, { lane }).catch(() => {})
  }
  return got ? `${got.slice(0, 3)}***(${got.length}자)` : ''
}

try {
  await closeAll()
  const before = await identity()
  console.log('로그인 전 신원:', before || '(로그아웃 또는 판정 불가)')
  if (!before) {
    await call('new_tab', { url: 'https://www.musinsa.com/auth/login', profile: label }, { lane })
    await sleep(6000)
    const res = await call('login', { accountLabel: label }, { lane })
    console.log('login 도구 응답:', res.replace(/\s+/g, ' ').slice(0, 120))
    await sleep(8000)
    await closeAll()
    const after = await identity()
    console.log('로그인 후 신원:', after || '(여전히 로그아웃)')
  }
  console.log('DONE')
} catch (e) {
  console.log('EXCEPTION', String(e?.message ?? e).slice(0, 200))
} finally {
  await closeAll()
}
