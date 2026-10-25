// 하네스 브릿지 — 밖의 LangGraph 하네스가 이 앱의 도구를 HTTP 로 부르는 문.
//
// 규칙
// - 127.0.0.1 에만 바인딩한다. 외부에서는 닿을 수 없다
// - 모든 요청은 X-Samba-Token 이 설정의 토큰과 같아야 한다(길이가 같을 때만 상수 시간 비교)
// - 요청마다 도구 세션을 열고 닫는다. 채팅 실행이 도는 중이거나 다른 요청이 도는 중이면 409
// - 응답에 비밀값은 없다 — 도구가 돌려주는 본문 그대로다(도구가 값을 돌려주지 않는다)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { ToolSession } from '../agent/runner'
import type { ParsedLogin } from '../import/passwords-csv'
import type { ImportPasswordsResult } from '../../shared/import'
import { clearSiteCookies } from '../browser/cookie-clear'
import { runFromBridge } from '../browser/human-activity'

export interface BridgeDeps {
  /** lane 이 있으면 그 레인 세션(다른 레인과 동시에 열린다) */
  openSession: (onStep: (label: string, ok: boolean) => void, lane?: string) => ToolSession
  token: () => string
  toolTimeoutMs?: number
  /** 제한 시간 뒤에도 도구 호출이 안 끝나면 이만큼 더 기다렸다가 강제로 busy 를 푼다 */
  hangGraceMs?: number
  /** 삼바웨이브 연동 — 로그인 행을 금고에 반영한다. 금고가 잠겨 있으면 'locked' 를 던진다 */
  importLogins?: (rows: ParsedLogin[]) => ImportPasswordsResult
}

const DEFAULT_TOOL_TIMEOUT_MS = 90_000
// 실기: 하네스가 죽어 응답을 못 받은 도구 호출이 영영 안 끝나 busy 가 풀리지 않았다(이후 모든 요청 409).
// 늦게 끝나는 호출은 지켜보되, 이 시간이 지나면 세션을 닫고 문을 연다
const DEFAULT_HANG_GRACE_MS = 60_000
const MAX_BODY_BYTES = 1024 * 1024

/** 마지막 브릿지 호출 뒤 이 시간 안이면 자동화가 도는 중으로 본다(페이지 대화상자 자동 처리) */
export const BRIDGE_ACTIVE_WINDOW_MS = 2 * 60_000

export class BridgeServer {
  private server: Server | null = null
  /** 지금 도구를 돌리는 중인가 — 한 손발이라 동시에 하나만 */
  private busy = false
  /** 지금 도는 레인들 — 레인이 다르면 동시에 돈다(하네스 계정 동시 처리) */
  private busyLanes = new Set<string>()
  /** 마지막으로 도구 호출이 시작·끝난 시각(ms) — 호출 사이 틈에 뜬 페이지 대화상자도 자동화 중으로 본다 */
  private lastActivityAt = 0

  constructor(private readonly deps: BridgeDeps) {}

  /**
   * 하네스가 브릿지로 자동화를 돌리고 있는가. 호출 중이거나 마지막 호출 뒤 windowMs 안이면 true.
   * 페이지 대화상자 자동 처리 조건에 쓴다 — 실기 2026-09-25: 하네스가 도는 동안 무신사 "옵션을 선택해 주세요"
   * alert 20개가 닫히지 않고 쌓였다(AI 채팅 작업일 때만 자동 처리하고 있었다)
   */
  recentlyActive(windowMs = BRIDGE_ACTIVE_WINDOW_MS, now = Date.now()): boolean {
    if (this.busy || this.busyLanes.size > 0) return true
    return this.lastActivityAt > 0 && now - this.lastActivityAt < windowMs
  }

  listening(): boolean {
    return this.server?.listening === true
  }

  address(): { address: string; port: number } | null {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { address: a.address, port: a.port } : null
  }

  async start(port: number): Promise<number> {
    await this.stop()
    this.busy = false
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (e) => console.error('브릿지 서버 오류', e.message))
    const a = server.address()
    return a && typeof a === 'object' ? a.port : port
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // keep-alive 소켓이 열려 있으면 close 콜백이 영영 안 온다 — 바로 끊는다
      server.closeAllConnections()
    })
  }

  private authorized(req: IncomingMessage): boolean {
    const given = req.headers['x-samba-token']
    const expected = this.deps.token()
    if (typeof given !== 'string' || expected === '') return false
    const givenBuf = Buffer.from(given)
    const expectedBuf = Buffer.from(expected)
    if (givenBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(givenBuf, expectedBuf)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) return json(res, 401, { error: 'unauthorized' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') return this.health(res)
    if (req.method === 'POST' && url.pathname === '/vault/import-logins') return this.importLogins(req, res)
    if (req.method === 'POST' && url.pathname === '/cookies/clear') return this.clearCookies(req, res)
    const m = /^\/tool\/([a-z0-9_]{1,64})$/.exec(url.pathname)
    if (req.method === 'POST' && m) return this.tool(m[1], req, res)
    return json(res, 404, { error: 'not found' })
  }

  /**
   * 삼바웨이브 계정을 키마스터에 넣는다. 본문 { logins: [{ url, username, password, name? }] }.
   * 응답에는 건수만 담는다(비밀값 없음). 이 경로는 127.0.0.1 + 토큰으로만 열린다
   */
  private async importLogins(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.deps.importLogins) return json(res, 404, { error: 'not found' })
    let body: string
    try {
      body = await readBody(req)
    } catch (e: unknown) {
      if (e instanceof BodyTooLarge) return json(res, 413, { error: 'body too large' })
      return json(res, 400, { error: 'invalid body' })
    }
    let rows: ParsedLogin[]
    try {
      const parsed = JSON.parse(body) as { logins?: unknown }
      if (!Array.isArray(parsed.logins) || parsed.logins.length === 0 || parsed.logins.length > 500) {
        return json(res, 400, { error: 'logins 는 1~500개 배열이어야 합니다' })
      }
      rows = []
      for (const raw of parsed.logins) {
        const r = raw as Record<string, unknown>
        const url = typeof r.url === 'string' ? r.url.trim() : ''
        const username = typeof r.username === 'string' ? r.username.trim() : ''
        const password = typeof r.password === 'string' ? r.password : ''
        if (!url || !username || !password) continue
        const name = typeof r.name === 'string' ? r.name.trim() : ''
        rows.push({ name, url, host: '', username, password, note: '' })
      }
    } catch {
      return json(res, 400, { error: 'invalid json' })
    }
    try {
      const result = this.deps.importLogins(rows)
      json(res, 200, { ok: true, ...result })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'locked') return json(res, 423, { ok: false, error: 'vault locked' })
      json(res, 500, { ok: false, error: 'import failed' })
    }
  }

  /**
   * 한 사이트의 쿠키만 지운다. 본문 { profile, host, automation? }. 로그인 사이트 허용 목록의 호스트만 받는다.
   * 쿠키가 쌓여 서버가 400(Cookie Too Large)으로 사이트 전체를 막을 때 세션 관리자가 쓴다. 응답은 지운 개수뿐이다
   */
  private async clearCookies(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string
    try {
      body = await readBody(req)
    } catch (e: unknown) {
      if (e instanceof BodyTooLarge) return json(res, 413, { error: 'body too large' })
      return json(res, 400, { error: 'invalid body' })
    }
    let parsed: { profile?: unknown; host?: unknown; automation?: unknown }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      return json(res, 400, { error: 'invalid json' })
    }
    try {
      const r = await clearSiteCookies(parsed)
      json(res, r.ok ? 200 : 400, r)
    } catch {
      json(res, 500, { ok: false, error: 'clear failed' })
    }
  }

  private async health(res: ServerResponse): Promise<void> {
    if (this.busy) return json(res, 409, { error: 'busy' })
    let session: ToolSession
    try {
      session = this.deps.openSession(() => {})
    } catch {
      return json(res, 409, { error: 'busy' })
    }
    try {
      json(res, 200, { ok: true, tools: session.names() })
    } finally {
      session.dispose()
    }
  }

  private async tool(name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawLane = req.headers['x-samba-lane']
    const lane =
      typeof rawLane === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/.test(rawLane) ? rawLane : undefined
    // 레인 없는 요청은 단독(다른 요청·레인이 없어야 한다). 레인 요청은 같은 레인만 겹치지 않으면 된다
    if (this.busy) return json(res, 409, { error: 'busy' })
    if (lane ? this.busyLanes.has(lane) : this.busyLanes.size > 0) {
      return json(res, 409, { error: 'busy' })
    }
    let body: string
    try {
      body = await readBody(req)
    } catch (e: unknown) {
      if (e instanceof BodyTooLarge) return json(res, 413, { error: 'body too large' })
      return json(res, 400, { error: 'invalid body' })
    }
    let args: Record<string, unknown>
    try {
      const parsed: unknown = body.trim() === '' ? {} : JSON.parse(body)
      const a = (parsed as { args?: unknown }).args
      args = a && typeof a === 'object' ? (a as Record<string, unknown>) : {}
    } catch {
      return json(res, 400, { error: 'invalid json' })
    }
    const steps: Array<{ label: string; ok: boolean }> = []
    let session: ToolSession
    try {
      session = this.deps.openSession((label, ok) => steps.push({ label, ok }), lane)
    } catch {
      return json(res, 409, { error: 'busy' })
    }
    if (!session.names().includes(name)) {
      session.dispose()
      return json(res, 404, { error: `unknown tool: ${name}` })
    }
    const hold = (): void => {
      this.lastActivityAt = Date.now()
      if (lane) this.busyLanes.add(lane)
      else this.busy = true
    }
    const free = (): void => {
      this.lastActivityAt = Date.now()
      if (lane) this.busyLanes.delete(lane)
      else this.busy = false
    }
    hold()
    const timeoutMs = this.deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    // 브릿지 요청은 사람이 보던 탭을 바꾸지 않는다(visible-guard.ts) — 탭 전환 기록에는 출처(레인)를 남긴다
    const callPromise = runFromBridge(lane ? `bridge:${lane}` : 'bridge', () => session.call(name, args))
    // 제한 시간 뒤에도 callPromise 는 계속 돌 수 있다 — 늦게 끝나도 세션 정리와 busy 해제는 한 번만
    let settledByTimer = false
    try {
      const result = await Promise.race([
        callPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            settledByTimer = true
            reject(new BridgeTimeout())
          }, timeoutMs)
        })
      ])
      // 레인 요청이면 레인 이름을 돌려준다 — 하네스가 이 앱이 레인을 아는지 확인한다(예전 앱은 머리글을 무시한다)
      json(res, 200, { ok: true, result, steps, ...(lane ? { lane } : {}) })
    } catch (e: unknown) {
      if (settledByTimer) {
        // 504 를 먼저 보낸다 — 세션은 아직 안 닫는다, callPromise 가 끝날 때 정리한다
        json(res, 504, { ok: false, error: 'tool timeout' })
      } else {
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (settledByTimer) {
        // 세션 정리와 busy 해제는 한 번만 — 늦게 끝나거나(finally) 유예가 지나거나(grace) 먼저 오는 쪽이 한다
        let released = false
        const release = (why: string): void => {
          if (released) return
          released = true
          if (why !== 'finished')
            console.warn(`브릿지: 도구 호출이 안 끝나 강제로 세션을 닫는다 (${why})`)
          session.dispose()
          free()
        }
        const graceMs = this.deps.hangGraceMs ?? DEFAULT_HANG_GRACE_MS
        const grace = setTimeout(() => release('hang'), graceMs)
        callPromise
          .catch((e: unknown) => {
            const message = e instanceof Error ? e.message : String(e)
            console.warn('브릿지: 제한 시간 뒤 늦게 끝난 도구 호출 실패', message)
          })
          .finally(() => {
            clearTimeout(grace)
            release('finished')
          })
      } else {
        session.dispose()
        free()
      }
    }
  }
}

class BridgeTimeout extends Error {}
class BodyTooLarge extends Error {}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true
          // 소켓을 끊지 않는다 — 핸들러가 413 을 보낸 뒤 끝낸다. 남은 데이터는 흘려보낸다
          req.removeAllListeners('data')
          req.resume()
          reject(new BodyTooLarge())
        }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (e) => {
      if (!settled) {
        settled = true
        reject(e)
      }
    })
  })
}
