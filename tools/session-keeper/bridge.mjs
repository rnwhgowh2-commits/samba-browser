// 하네스 브릿지(127.0.0.1) 클라이언트 — 세션 관리자가 앱의 도구를 레인(lane)으로 부른다.
// 토큰·포트는 호출마다 앱 설정(%APPDATA%\SAMBA Browser\config.json)에서 읽는다. 어디에도 복사해 두지 않는다.
// 비밀번호·쿠키 값은 이 모듈을 지나지 않는다(도구가 값을 돌려주지 않는다).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONFIG =
  process.env.SAMBA_BROWSER_CONFIG ?? join(process.env.APPDATA ?? '', 'SAMBA Browser', 'config.json')
const CALL_TIMEOUT_MS = 120_000

export class BridgeDown extends Error {}
export class BridgeBusy extends Error {}
// 앱은 떠 있는데 응답이 제한 시간 안에 안 왔다(PC 부하) — 앱이 꺼진 것(BridgeDown)과 구분해 그 호출만 포기하고 다음으로 간다
export class BridgeTimeout extends BridgeDown {}

function target() {
  let c
  try {
    c = JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch {
    throw new BridgeDown('앱 설정 파일을 읽지 못했습니다')
  }
  if (!c.bridgeEnabled || !c.bridgeToken) throw new BridgeDown('브릿지가 꺼져 있습니다')
  return { base: `http://127.0.0.1:${c.bridgePort ?? 47811}`, token: c.bridgeToken }
}

async function request(path, { method = 'GET', body, lane, timeoutMs } = {}) {
  const { base, token } = target()
  let res
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        'x-samba-token': token,
        'content-type': 'application/json',
        ...(lane ? { 'x-samba-lane': lane } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? CALL_TIMEOUT_MS)
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new BridgeTimeout(`브릿지 응답 지연(${Math.round((timeoutMs ?? CALL_TIMEOUT_MS) / 1000)}초)`)
    throw new BridgeDown(`브릿지에 연결하지 못했습니다(${e?.cause?.code ?? e?.message ?? e})`)
  }
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { error: text.slice(0, 200) }
  }
  return { status: res.status, json }
}

export async function health() {
  const r = await request('/health')
  // 앱 채팅 중 /health는 409지만 독립 레인은 사용 가능하다. 연결 단절로 오판해 점검을 멈추지 않는다.
  if (r.status === 409) {
    const lane = 'keeper-health'
    const probe = await request('/tool/list_tabs', { method: 'POST', body: { args: {} }, lane, timeoutMs: 10_000 })
    if (probe.status === 200 && probe.json.ok && probe.json.lane === lane) return ['list_tabs']
    if (probe.status === 409) throw new BridgeBusy('앱이 다른 작업 중입니다(409)')
    return null
  }
  return r.status === 200 ? r.json.tools ?? [] : null
}

/** 도구 1회 호출. 409(바쁨)는 잠깐 쉬었다가 몇 번 다시 시도한다. 결과 문자열을 돌려준다 */
export async function call(tool, args = {}, { lane, retries = 6, timeoutMs } = {}) {
  for (let i = 0; ; i++) {
    const r = await request(`/tool/${tool}`, { method: 'POST', body: { args }, lane, timeoutMs })
    if (r.status === 200 && r.json.ok) return String(r.json.result ?? '')
    if (r.status === 409 && i < retries) {
      await sleep(2000 + i * 1500)
      continue
    }
    if (r.status === 409) throw new BridgeBusy('앱이 다른 작업 중입니다(409)')
    if (r.status === 504) throw new BridgeTimeout('브릿지 도구 제한 시간 초과(504)')
    throw new Error(`도구 ${tool} 실패: ${r.status} ${r.json.error ?? ''}`.trim())
  }
}

/** 앱 브릿지에 JSON 을 보낸다(도구 호출이 아닌 로컬 입구용). 응답 본문에 비밀값은 없다 */
export async function postJson(path, body) {
  return request(path, { method: 'POST', body })
}

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
