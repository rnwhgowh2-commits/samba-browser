// 시험: 같은 프로필에서 주소만 바꿔 login 도구 응답을 비교한다(값 출력 없음, 응답 앞부분만).
// 사용: node login-probe.mjs <프로필·라벨> <url> [<url> ...]
import { call, sleep } from '../bridge.mjs'

const [label, ...urls] = process.argv.slice(2)
const lane = 'login-probe'
const tabIdOf = (r) => /tab ([0-9a-f-]{36})/.exec(String(r))?.[1]

for (const url of urls) {
  const t0 = Date.now()
  let id = ''
  try {
    const r = await call('new_tab', { url, profile: label }, { lane })
    id = tabIdOf(r)
    await sleep(3000)
    const res = await call('login', { accountLabel: label }, { lane })
    console.log(`[${url}] ${Math.round((Date.now() - t0) / 1000)}초: ${res.replace(/\s+/g, ' ').slice(0, 100)}`)
  } catch (e) {
    console.log(`[${url}] 오류: ${String(e?.message ?? e).slice(0, 120)}`)
  } finally {
    if (id) await call('close_tab', { id }, { lane }).catch(() => {})
  }
}
console.log('DONE')
