#!/usr/bin/env node
// SAMBA Browser 하네스 브릿지(HTTP) → MCP(stdio) 어댑터. 의존성 없음.
// - 도구 목록: 같은 폴더의 tools.json(앱 소스에서 추출) ∩ 브릿지 /health 의 실제 도구 이름
// - 토큰·포트: 호출할 때마다 앱 설정(%APPDATA%\SAMBA Browser\config.json)에서 읽는다 → MCP 설정에 비밀값을 복사하지 않는다
// - 브릿지가 꺼져 있으면(앱 미실행·설정 꺼짐) 도구 호출이 오류 문구로 안내한다
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = process.env.SAMBA_BROWSER_CONFIG ?? join(process.env.APPDATA ?? '', 'SAMBA Browser', 'config.json')
const CALL_TIMEOUT_MS = 120_000
const EXCLUDE = new Set(['done']) // 채팅 전용 종료 도구 — 브릿지에 없다

const manifest = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8'))

// --- 세션별 레인(옵트인) ---------------------------------------------------------------------------
// 앱 브릿지는 레인 없는 호출을 단독으로 본다 — 다른 레인(하네스·세션 관리자) 호출이 하나라도 돌면 409 busy.
// 이 MCP 프로세스는 Claude 세션마다 따로 뜬다. 세션이 samba_lane 도구로 켜야만 이 프로세스의 호출에
// X-Samba-Lane 머리글이 붙는다. 켜지 않은 세션은 예전과 똑같이 레인 없이 나간다(탭 목록·동작 변화 없음).
// 레인을 켜면 그 레인이 연 탭만 보인다 — 사람이 열어 둔 탭이나 다른 세션의 탭은 목록에 안 나온다.
const LANE_RE = /^cc-[A-Za-z0-9_.@-]{1,40}$/
const LANE_TOOL = {
  name: 'samba_lane',
  description:
    '이 세션 전용 레인을 켜거나 끈다(삼바 브라우저를 여러 세션이 동시에 쓸 때 409 busy 를 피한다). ' +
    'on=true 면 이 세션의 이후 모든 호출이 자기 레인으로 나가 다른 세션 호출과 겹치지 않고, 이 레인이 new_tab 으로 연 탭만 list_tabs 에 보인다. ' +
    'name 은 생략하면 자동(cc-xxxxxx), 직접 주면 cc- 로 시작해야 한다. on=false 면 레인 없는 예전 방식으로 돌아간다. 인자 없이 부르면 현재 상태만 알려 준다.',
  inputSchema: {
    type: 'object',
    properties: { on: { type: 'boolean' }, name: { type: 'string' } },
    additionalProperties: false
  }
}
let lane = null // 이 프로세스의 레인 이름. null 이면 레인 없음(기본)
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

function bridge() {
  const c = JSON.parse(readFileSync(CONFIG, 'utf8'))
  if (!c.bridgeEnabled || !c.bridgeToken) {
    throw new Error('SAMBA Browser 브릿지가 꺼져 있습니다(설정 → 동작 → 하네스 브릿지). 앱을 실행하고 브릿지를 켜세요.')
  }
  return { base: `http://127.0.0.1:${c.bridgePort ?? 47811}`, token: c.bridgeToken }
}

// laneName 은 호출 시작 때 고정해서 넘긴다 — 재시도 사이에 samba_lane 으로 전역 lane 이 바뀌어도 이미 시작한 요청은 처음 범위로 나간다
async function call(path, init = {}, laneName = lane) {
  const { base, token } = bridge()
  const res = await fetch(base + path, {
    ...init,
    headers: { 'x-samba-token': token, 'content-type': 'application/json', ...(laneName ? { 'x-samba-lane': laneName } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { status: res.status, body }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function listTools() {
  let live = null
  try {
    const r = await call('/health')
    if (r.status === 200 && Array.isArray(r.body.tools)) live = new Set(r.body.tools)
  } catch { /* 꺼져 있어도 목록은 보여 준다 */ }
  return [
    ...manifest
      .filter((t) => !EXCLUDE.has(t.name) && (live ? live.has(t.name) : true))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    LANE_TOOL
  ]
}

const textResult = (text, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] })

// 409 는 호출이 시작되기 전에 거절된 것이다(브릿지가 hold 전에 돌려준다) — 다시 보내도 중복 실행이 아니다.
// 레인이 켜졌을 때만 짧게 다시 시도한다(기본 동작은 그대로 한 번만 보낸다)
async function callWithBusyRetry(path, init, laneName = lane) {
  let r = await call(path, init, laneName)
  for (let i = 0; laneName && r.status === 409 && i < 4; i++) {
    await sleepMs(700 + i * 400)
    r = await call(path, init, laneName)
  }
  return r
}

async function laneTool(args) {
  const a = args ?? {}
  if (a.on === undefined && a.name === undefined) {
    return textResult(lane ? `레인 켜짐: ${lane}` : '레인 꺼짐(레인 없는 기본 방식)')
  }
  if (a.on === false) {
    const was = lane
    lane = null
    return textResult(was ? `레인 ${was} 을(를) 껐다. 이후 호출은 레인 없이 나간다. (그 레인이 연 탭은 앱에 남아 있다 — 필요하면 다시 켜서 close_tab)` : '이미 꺼져 있다')
  }
  const name = typeof a.name === 'string' && a.name ? a.name : `cc-${Math.random().toString(36).slice(2, 8)}`
  if (!LANE_RE.test(name)) return textResult('레인 이름은 cc- 로 시작하는 영문·숫자·_.@- 만 쓸 수 있다(최대 43자)', true)
  // 앱이 레인을 아는지 읽기 전용 호출로 확인한다 — 예전 앱은 머리글을 무시하고 응답에 lane 이 없다.
  // 확인된 뒤에만 전역 lane 을 바꾼다(확인이 오류로 끝나도 이전 상태가 그대로 남는다). 네트워크 오류는 callTool 바깥에서 잡힌다
  const r = await callWithBusyRetry('/tool/list_tabs', { method: 'POST', body: JSON.stringify({ args: {} }) }, name)
  if (r.status === 200 && r.body.ok && r.body.lane === name) {
    lane = name
    return textResult(`레인 켜짐: ${name} — 앱이 레인을 인식했다. 이 세션은 이제 자기 레인으로 일한다(자기가 new_tab 으로 연 탭만 list_tabs 에 보인다).`)
  }
  if (r.status === 200 && r.body.ok) {
    return textResult(`앱이 레인을 인식하지 못했다(응답에 lane 없음 — 예전 앱). 레인을 켜지 않았다. 현재 상태: ${lane ? '레인 ' + lane : '레인 꺼짐'}.`, true)
  }
  return textResult(`앱 확인 호출이 ${r.status} 로 끝나 레인 ${name} 을(를) 켜지 않았다(현재 상태: ${lane ? '레인 ' + lane : '레인 꺼짐'}). 잠시 뒤 samba_lane 을 다시 불러 보자.`, true)
}

async function callTool(name, args) {
  if (name === LANE_TOOL.name) return laneTool(args)
  if (!manifest.some((t) => t.name === name) || EXCLUDE.has(name)) throw new Error(`unknown tool: ${name}`)
  const r = await callWithBusyRetry(`/tool/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ args: args ?? {} }) })
  if (r.status === 200 && r.body.ok) {
    return { content: [{ type: 'text', text: typeof r.body.result === 'string' ? r.body.result : JSON.stringify(r.body.result) }] }
  }
  const why = r.status === 409 ? '409 busy — 앱의 채팅 AI 또는 다른 호출이 실행 중입니다. 잠시 뒤 다시 시도하세요.' +
      (lane ? ` (레인 ${lane})` : ' 다른 세션과 동시에 쓰려면 samba_lane 도구로 이 세션 전용 레인을 켜세요.')
    : r.status === 401 ? '401 토큰 불일치 — 앱 설정의 브릿지 토큰이 바뀌었을 수 있습니다.'
    : r.status === 504 ? '504 도구 제한 시간(90초) 초과'
    : `${r.status} ${r.body.error ?? r.body.raw ?? ''}`
  return { isError: true, content: [{ type: 'text', text: why }] }
}

async function handle(msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'samba-browser', version: '0.1.0' }
      })
    }
    if (method === 'ping') return ok(id, {})
    if (method === 'tools/list') return ok(id, { tools: await listTools() })
    if (method === 'tools/call') {
      try {
        return ok(id, await callTool(params?.name, params?.arguments))
      } catch (e) {
        return ok(id, { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] })
      }
    }
    if (id === undefined) return // notifications/*
    return fail(id, -32601, `method not found: ${method}`)
  } catch (e) {
    if (id !== undefined) fail(id, -32603, e instanceof Error ? e.message : String(e))
  }
}

const pending = new Set()
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const p = handle(msg).finally(() => pending.delete(p))
  pending.add(p)
})
// 입력이 닫혀도 진행 중인 요청은 응답을 끝낸 뒤 종료한다
// process.exit 를 쓰지 않는다 — Windows 에서 stdin 종료와 겹치면 libuv 어서션으로 죽는다. 할 일이 없으면 자연 종료된다
rl.on('close', () => { void Promise.allSettled([...pending]) })
