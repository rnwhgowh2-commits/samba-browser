import type { CdpLike } from './network-recorder'

// 요청 가로채기 가드 — 데이터를 바꾸는 요청(GET·HEAD·OPTIONS 가 아닌 것)을 서버로 보내지 않고 가짜 200 으로 막는다.
// 막힌 요청의 본문은 network_record 가 이미 기록하므로(network_get) "이 버튼이 무엇을 보내려 했나"만 안전하게 볼 수 있다.
// 모든 일시정지 요청은 반드시 풀어 준다(continue 또는 fulfill) — 안 풀면 페이지가 멈춘다.

const PASS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const FAKE_BODY = Buffer.from('{"intercepted":true}').toString('base64')

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export class NetworkGuard {
  private active = false
  private allow: string[] = []
  private blocked = 0
  private onMessage: ((e: unknown, method: string, params: P, sessionId?: string) => void) | null =
    null
  private onDetach: (() => void) | null = null

  constructor(
    private readonly dbg: CdpLike,
    private readonly onIntercept: (networkId: string) => void = () => {}
  ) {}

  get isActive(): boolean {
    return this.active
  }

  status(): { active: boolean; blocked: number; allow: string[] } {
    return { active: this.active, blocked: this.blocked, allow: this.allow }
  }

  /** allow: 이 글자가 주소에 들어 있으면 쓰기 요청도 통과시킨다(예: 스캔·검색처럼 읽기인 POST) */
  async enable(allow: string[] = []): Promise<void> {
    this.allow = allow.map((s) => s.toLowerCase()).filter(Boolean)
    if (this.active) return
    this.blocked = 0
    this.onMessage = (_e, method, params, sessionId) => {
      if (method === 'Fetch.requestPaused') void this.handlePaused(params ?? {}, sessionId)
    }
    this.onDetach = () => {
      this.active = false
      this.unhook()
    }
    this.dbg.on('message', this.onMessage)
    this.dbg.on('detach', this.onDetach)
    try {
      await this.dbg.sendCommand('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }]
      })
      this.active = true
    } catch (e) {
      this.unhook()
      throw e
    }
  }

  async disable(): Promise<void> {
    this.active = false
    await this.dbg.sendCommand('Fetch.disable').catch(() => undefined)
    this.unhook()
  }

  private async handlePaused(p: P, sessionId?: string): Promise<void> {
    const requestId = String(p.requestId ?? '')
    if (!requestId) return
    const send = (method: string, params: object): Promise<unknown> =>
      sessionId
        ? this.dbg.sendCommand(method, params, sessionId)
        : this.dbg.sendCommand(method, params)
    try {
      const req = (p.request ?? {}) as P
      const method = String(req.method ?? 'GET').toUpperCase()
      const url = String(req.url ?? '')
      const passes =
        !this.active ||
        PASS_METHODS.has(method) ||
        this.allow.some((a) => url.toLowerCase().includes(a)) ||
        /^(data|blob|chrome-extension):/i.test(url)
      if (passes) {
        await send('Fetch.continueRequest', { requestId })
        return
      }
      this.blocked++
      if (typeof p.networkId === 'string') this.onIntercept(p.networkId)
      await send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Allow-Headers', value: '*' }
        ],
        body: FAKE_BODY
      })
    } catch {
      // 어떤 실패든 요청이 멈춰 있으면 안 된다 — 마지막으로 계속 진행을 시도한다
      await send('Fetch.continueRequest', { requestId }).catch(() => undefined)
    }
  }

  private unhook(): void {
    if (this.onMessage) this.dbg.removeListener('message', this.onMessage)
    if (this.onDetach) this.dbg.removeListener('detach', this.onDetach)
    this.onMessage = null
    this.onDetach = null
  }
}
