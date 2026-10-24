import {
  clip,
  isSensitiveEndpoint,
  isTextualMime,
  OMITTED,
  redactBody,
  redactHeaders,
  redactUrl
} from '../../shared/network-redact'

// 탭 하나의 네트워크 요청·응답을 CDP(Network 도메인)로 기록한다.
// AI 가 개발자도구 Network 패널 대신 "이 화면이 어떤 API 를 어떤 조건으로 불렀나"를 볼 수 있게 하는 입구다.
// 읽기 전용 관측이며 요청을 막거나 바꾸지 않는다. 비밀값(쿠키·토큰·비밀번호)은 기록 단계에서 가린다.

/** 디버거 최소 모양 — Electron 의 webContents.debugger 와 시험용 대역이 함께 만족한다 */
export interface CdpLike {
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>
  on(event: string, listener: (...args: any[]) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface NetworkEntry {
  index: number
  key: string
  method: string
  url: string
  resourceType: string
  documentUrl: string
  at: string
  startedTs: number
  status: number | null
  statusText: string
  mime: string
  fromCache: boolean
  protocol: string
  durationMs: number | null
  finished: boolean
  failed: string | null
  redirectTo: string | null
  initiator: { type: string; url?: string; top?: string }
  sensitive: boolean
  intercepted: boolean
  reqHeaders: Record<string, string>
  reqBody: string | null
  reqBodyBytes: number
  resHeaders: Record<string, string>
  resBody: string | null
  resBodyBytes: number
  resBodyNote: string | null
}

export interface RecorderOptions {
  /** 보관할 요청 수 상한(넘으면 오래된 것부터 버린다) */
  maxEntries?: number
  /** 응답 본문으로 쌓아 두는 글자 수 합계 상한 */
  bodyBudgetChars?: number
  /** 본문 하나의 보관 상한(글자) */
  bodyMaxChars?: number
  /** 본문을 싣지 않을 요청인가(기본: 로그인·인증·결제 쓰기 계열). 호출부가 더 엄격하게 바꿀 수 있다 */
  omitBodies?: (url: string, documentUrl: string, method: string) => boolean
  /** 스크립트(JS) 응답 본문도 받아 둘지 */
  includeScripts?: boolean
}

export interface ListQuery {
  filter?: string
  /** 소문자 자원 종류 목록. 비어 있으면 기본(xhr·fetch·document·other·ping·prefetch) */
  types?: string[]
  method?: string
  minStatus?: number
  limit?: number
  offset?: number
}

const DEFAULT_TYPES = new Set([
  'xhr',
  'fetch',
  'document',
  'other',
  'ping',
  'prefetch',
  'eventsource'
])
const BODY_TYPES = new Set(['xhr', 'fetch', 'document', 'other', 'ping', 'prefetch', 'eventsource'])
const MAX_ENCODED_BODY = 1_500_000
const HEADER_KEEP = 40

type CdpParams = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export class NetworkRecorder {
  private entries: NetworkEntry[] = []
  private byKey = new Map<string, NetworkEntry>()
  private nextIndex = 1
  private pending = new Set<Promise<void>>()
  private childSessions = new Set<string>()
  // 요청 가로채기 가드가 막은 Network requestId (Fetch 이벤트가 Network 이벤트보다 먼저 올 수 있어 따로 기억한다)
  private interceptedIds = new Set<string>()
  // 문서(HTML) 본문을 getResponseBody 로 못 받을 때 Page.getResourceContent 로 받기 위한 프레임 id
  private frameOf = new Map<string, { frameId: string; url: string }>()
  private bodyChars = 0
  private active = false
  private stopReason: string | null = null
  private urlFilter = ''
  private startedAt = 0
  private onMessage:
    ((e: unknown, method: string, params: CdpParams, sessionId?: string) => void) | null = null
  private onDetach: ((e: unknown, reason: string) => void) | null = null

  private readonly maxEntries: number
  private readonly bodyBudget: number
  private readonly bodyMax: number
  private readonly omit: (url: string, documentUrl: string, method: string) => boolean
  private readonly includeScripts: boolean

  constructor(
    private readonly dbg: CdpLike,
    opts: RecorderOptions = {}
  ) {
    this.maxEntries = opts.maxEntries ?? 600
    this.bodyBudget = opts.bodyBudgetChars ?? 6_000_000
    this.bodyMax = opts.bodyMaxChars ?? 40_000
    this.omit = opts.omitBodies ?? ((url, _doc, method) => isSensitiveEndpoint(url, method))
    this.includeScripts = opts.includeScripts ?? false
  }

  get isActive(): boolean {
    return this.active
  }

  status(): {
    active: boolean
    count: number
    startedAt: number
    urlFilter: string
    stopReason: string | null
    bodyChars: number
  } {
    return {
      active: this.active,
      count: this.entries.length,
      startedAt: this.startedAt,
      urlFilter: this.urlFilter,
      stopReason: this.stopReason,
      bodyChars: this.bodyChars
    }
  }

  /** 기록을 시작한다. 이미 켜져 있으면 필터만 바꾼다 */
  async start(urlFilter = '', clearFirst = true): Promise<void> {
    this.urlFilter = urlFilter.toLowerCase()
    if (clearFirst) this.clear()
    if (this.active) return
    this.onMessage = (_e, method, params, sessionId) => this.handle(method, params ?? {}, sessionId)
    this.onDetach = (_e, reason) => {
      this.active = false
      this.stopReason = `debugger detached: ${reason}`
      this.detachListeners()
    }
    this.dbg.on('message', this.onMessage)
    this.dbg.on('detach', this.onDetach)
    try {
      await this.dbg.sendCommand('Network.enable', {
        maxTotalBufferSize: 30_000_000,
        maxResourceBufferSize: 5_000_000,
        maxPostDataSize: 100_000
      })
      this.active = true
      this.stopReason = null
      this.startedAt = Date.now()
    } catch (e) {
      this.detachListeners()
      throw e
    }
    // 문서 본문 폴백(Page.getResourceContent)에 필요하다. 앱이 대화상자 감시로 이미 켜 두었다면 그대로다
    await this.dbg.sendCommand('Page.enable').catch(() => undefined)
    // 다른 사이트의 iframe(별도 프로세스)은 자식 세션으로 와야 보인다 — 실패해도 메인 프레임 기록은 계속한다
    try {
      await this.dbg.sendCommand('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      })
    } catch {
      // 일부 환경에서는 지원하지 않는다
    }
  }

  async stop(reason = 'stopped'): Promise<void> {
    if (!this.active) {
      this.detachListeners()
      return
    }
    this.active = false
    this.stopReason = reason
    await this.settle(1500)
    try {
      await this.dbg.sendCommand('Target.setAutoAttach', {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true
      })
    } catch {
      // 이미 떨어졌을 수 있다
    }
    for (const sid of this.childSessions) {
      await this.dbg.sendCommand('Network.disable', {}, sid).catch(() => undefined)
    }
    this.childSessions.clear()
    await this.dbg.sendCommand('Network.disable').catch(() => undefined)
    this.detachListeners()
  }

  /** 가로채기 가드가 이 요청을 막았다고 표시한다(가짜 200 이 돌아갔고 서버에는 가지 않았다) */
  markIntercepted(requestId: string): void {
    this.interceptedIds.add(requestId)
    const entry = this.byKey.get(this.keyOf(requestId))
    if (entry) {
      entry.intercepted = true
      entry.resBodyNote =
        'intercepted by network_guard: request was NOT sent to the server (fake 200)'
    }
  }

  clear(): void {
    this.interceptedIds.clear()
    this.entries = []
    this.byKey.clear()
    this.frameOf.clear()
    this.bodyChars = 0
    this.nextIndex = 1
  }

  /** 본문을 받아 오는 중인 작업이 끝나기를 기다린다(최대 ms) */
  async settle(ms = 2000): Promise<void> {
    if (this.pending.size === 0) return
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise((r) => setTimeout(r, ms))
    ])
  }

  list(q: ListQuery = {}): { rows: NetworkEntry[]; total: number } {
    const filter = (q.filter ?? '').toLowerCase()
    const types =
      q.types && q.types.length > 0 ? new Set(q.types.map((t) => t.toLowerCase())) : null
    const all = types?.has('all') ?? false
    const method = q.method?.toUpperCase()
    const matched = this.entries.filter((e) => {
      if (!all) {
        if (types ? !types.has(e.resourceType) : !DEFAULT_TYPES.has(e.resourceType)) return false
      }
      if (method && e.method !== method) return false
      if (q.minStatus !== undefined && (e.status === null || e.status < q.minStatus)) return false
      if (filter && !e.url.toLowerCase().includes(filter)) return false
      return true
    })
    const offset = Math.max(0, q.offset ?? 0)
    const limit = Math.min(200, Math.max(1, q.limit ?? 60))
    return { rows: matched.slice(offset, offset + limit), total: matched.length }
  }

  get(index: number): NetworkEntry | undefined {
    return this.entries.find((e) => e.index === index)
  }

  /** 메인 세션 명령에는 sessionId 인자를 넘기지 않는다 — Electron 은 이벤트의 메인 세션 id 를 빈 문자열('')로 주고, 빈 id 를 명령에 넘기면 거부한다 */
  private cmd(method: string, params: object, sessionId?: string): Promise<unknown> {
    return sessionId
      ? this.dbg.sendCommand(method, params, sessionId)
      : this.dbg.sendCommand(method, params)
  }

  // === CDP 이벤트 ===========================================================

  private handle(method: string, p: CdpParams, sessionId?: string): void {
    if (!this.active) return
    try {
      switch (method) {
        case 'Network.requestWillBeSent':
          return this.onRequest(p, sessionId)
        case 'Network.requestWillBeSentExtraInfo':
          return this.onRequestExtra(p, sessionId)
        case 'Network.responseReceived':
          return this.onResponse(p, sessionId)
        case 'Network.loadingFinished':
          return this.onFinished(p, sessionId)
        case 'Network.loadingFailed':
          return this.onFailed(p, sessionId)
        case 'Target.attachedToTarget':
          return this.onAttached(p)
        case 'Target.detachedFromTarget':
          if (typeof p.sessionId === 'string') this.childSessions.delete(p.sessionId)
          return
        default:
          return
      }
    } catch (e) {
      console.error('네트워크 기록 처리 실패', method, e instanceof Error ? e.message : String(e))
    }
  }

  private keyOf(requestId: string, sessionId?: string): string {
    return `${sessionId ?? ''}:${requestId}`
  }

  private onAttached(p: CdpParams): void {
    const sid = p.sessionId as string | undefined
    const type = (p.targetInfo?.type as string | undefined) ?? ''
    if (!sid || type !== 'iframe') return
    this.childSessions.add(sid)
    void this.dbg
      .sendCommand(
        'Network.enable',
        {
          maxTotalBufferSize: 30_000_000,
          maxResourceBufferSize: 5_000_000,
          maxPostDataSize: 100_000
        },
        sid
      )
      .catch(() => undefined)
    void this.dbg
      .sendCommand(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sid
      )
      .catch(() => undefined)
  }

  private onRequest(p: CdpParams, sessionId?: string): void {
    const req = p.request as CdpParams | undefined
    const requestId = p.requestId as string | undefined
    if (!req || !requestId) return
    const url = String(req.url ?? '')
    if (/^(data|blob|chrome-extension|devtools):/i.test(url)) return
    const key = this.keyOf(requestId, sessionId)
    const prev = this.byKey.get(key)
    if (prev && p.redirectResponse) {
      prev.status = Number(p.redirectResponse.status) || prev.status
      prev.statusText = String(p.redirectResponse.statusText ?? '')
      prev.redirectTo = redactUrl(url)
      prev.finished = true
      prev.durationMs =
        prev.durationMs ?? Math.max(0, Math.round((Number(p.timestamp) - prev.startedTs) * 1000))
    }
    if (this.urlFilter && !url.toLowerCase().includes(this.urlFilter)) {
      this.byKey.delete(key)
      return
    }
    const method = String(req.method ?? 'GET').toUpperCase()
    const documentUrl = String(p.documentURL ?? '')
    const sensitive = this.omit(url, documentUrl, method)
    if (typeof p.frameId === 'string' && String(p.type) === 'Document')
      this.frameOf.set(key, { frameId: p.frameId, url })
    const initiator = p.initiator as CdpParams | undefined
    const top = initiator?.stack?.callFrames?.[0] as CdpParams | undefined
    const entry: NetworkEntry = {
      index: this.nextIndex++,
      key,
      method,
      url: redactUrl(url),
      resourceType: String(p.type ?? 'other').toLowerCase(),
      documentUrl: redactUrl(documentUrl),
      at: new Date(Number(p.wallTime) ? Number(p.wallTime) * 1000 : Date.now()).toISOString(),
      startedTs: Number(p.timestamp) || 0,
      status: null,
      statusText: '',
      mime: '',
      fromCache: false,
      protocol: '',
      durationMs: null,
      finished: false,
      failed: null,
      redirectTo: null,
      initiator: {
        type: String(initiator?.type ?? ''),
        ...(initiator?.url ? { url: redactUrl(String(initiator.url)) } : {}),
        ...(top?.url
          ? { top: `${redactUrl(String(top.url))}:${Number(top.lineNumber ?? 0) + 1}` }
          : {})
      },
      sensitive,
      intercepted: this.interceptedIds.has(requestId),
      reqHeaders: this.pickHeaders(req.headers as Record<string, unknown> | undefined),
      reqBody: null,
      reqBodyBytes: 0,
      resHeaders: {},
      resBody: null,
      resBodyBytes: 0,
      resBodyNote: null
    }
    const post = typeof req.postData === 'string' ? req.postData : null
    if (post !== null) this.storeRequestBody(entry, post)
    else if (req.hasPostData === true && !sensitive)
      entry.reqBodyBytes = -1 // 나중에 받아 온다
    else if (req.hasPostData === true && sensitive) entry.reqBody = OMITTED
    this.entries.push(entry)
    this.byKey.set(key, entry)
    while (this.entries.length > this.maxEntries) {
      const dropped = this.entries.shift()
      if (dropped) {
        this.byKey.delete(dropped.key)
        this.frameOf.delete(dropped.key)
        this.bodyChars -= dropped.resBody?.length ?? 0
      }
    }
  }

  private pickHeaders(h: Record<string, unknown> | undefined): Record<string, string> {
    const masked = redactHeaders(h)
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(masked).slice(0, HEADER_KEEP)) out[k] = v
    return out
  }

  private storeRequestBody(entry: NetworkEntry, post: string): void {
    entry.reqBodyBytes = post.length
    if (entry.sensitive) {
      entry.reqBody = OMITTED
      return
    }
    const ct =
      Object.entries(entry.reqHeaders).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
    entry.reqBody = clip(redactBody(post, ct), 8000)
  }

  private onRequestExtra(p: CdpParams, sessionId?: string): void {
    const entry = this.byKey.get(this.keyOf(String(p.requestId ?? ''), sessionId))
    if (!entry || !p.headers) return
    // 실제로 나간 헤더 이름(쿠키 등)이 여기서 보인다 — 값은 가린 채 이름만 합친다
    const masked = this.pickHeaders(p.headers as Record<string, unknown>)
    for (const [k, v] of Object.entries(masked)) {
      if (!(k in entry.reqHeaders)) entry.reqHeaders[k] = v
    }
  }

  private onResponse(p: CdpParams, sessionId?: string): void {
    const entry = this.byKey.get(this.keyOf(String(p.requestId ?? ''), sessionId))
    const res = p.response as CdpParams | undefined
    if (!entry || !res) return
    entry.status = Number(res.status) || null
    entry.statusText = String(res.statusText ?? '')
    entry.mime = String(res.mimeType ?? '')
    entry.fromCache =
      res.fromDiskCache === true || res.fromServiceWorker === true || res.fromPrefetchCache === true
    entry.protocol = String(res.protocol ?? '')
    if (p.type) entry.resourceType = String(p.type).toLowerCase()
    entry.resHeaders = this.pickHeaders(res.headers as Record<string, unknown> | undefined)
  }

  private onFinished(p: CdpParams, sessionId?: string): void {
    const entry = this.byKey.get(this.keyOf(String(p.requestId ?? ''), sessionId))
    if (!entry) return
    entry.finished = true
    entry.durationMs = Math.max(0, Math.round((Number(p.timestamp) - entry.startedTs) * 1000))
    entry.resBodyBytes = Number(p.encodedDataLength) || 0
    const job = this.fetchBodies(entry, String(p.requestId), sessionId).catch(() => undefined)
    this.pending.add(job)
    void job.finally(() => this.pending.delete(job))
  }

  private onFailed(p: CdpParams, sessionId?: string): void {
    const entry = this.byKey.get(this.keyOf(String(p.requestId ?? ''), sessionId))
    if (!entry) return
    entry.finished = true
    entry.failed = String(p.errorText ?? (p.canceled ? 'canceled' : 'failed'))
    entry.durationMs = Math.max(0, Math.round((Number(p.timestamp) - entry.startedTs) * 1000))
  }

  private async fetchBodies(
    entry: NetworkEntry,
    requestId: string,
    sessionId?: string
  ): Promise<void> {
    // 요청 본문: 처음 이벤트에 안 실려 왔던 큰 본문
    if (entry.reqBodyBytes === -1) {
      try {
        const r = (await this.cmd(
          'Network.getRequestPostData',
          { requestId },
          sessionId
        )) as CdpParams
        if (typeof r?.postData === 'string') this.storeRequestBody(entry, r.postData)
        else entry.reqBodyBytes = 0
      } catch {
        entry.reqBodyBytes = 0
      }
    }
    // 응답 본문
    if (entry.sensitive) {
      entry.resBody = OMITTED
      return
    }
    if (entry.status === null || entry.status === 204 || entry.status === 304) return
    const type = entry.resourceType
    const wantsBody = BODY_TYPES.has(type) || (this.includeScripts && type === 'script')
    if (!wantsBody) {
      entry.resBodyNote = 'body not kept for this resource type'
      return
    }
    if (!isTextualMime(entry.mime)) {
      entry.resBodyNote = `body not kept (mime ${entry.mime || 'unknown'})`
      return
    }
    if (entry.resBodyBytes > MAX_ENCODED_BODY) {
      entry.resBodyNote = `body too large (${entry.resBodyBytes} bytes)`
      return
    }
    if (this.bodyChars >= this.bodyBudget) {
      entry.resBodyNote = 'body budget exhausted - call clear to free space'
      return
    }
    try {
      const r = await this.readBody(entry, requestId, sessionId)
      if (r.base64Encoded) {
        entry.resBodyNote = 'binary body not kept'
        return
      }
      const body = r.body
      const kept = clip(redactBody(body, entry.mime), this.bodyMax)
      entry.resBody = kept
      entry.resBodyBytes = entry.resBodyBytes || body.length
      this.bodyChars += kept.length
    } catch (e) {
      entry.resBodyNote = `body unavailable: ${e instanceof Error ? e.message.slice(0, 80) : 'error'}`
    }
  }

  /**
   * 응답 본문 읽기. 문서(HTML)는 페이지 전환이 끝나면 getResponseBody 가 '식별자 없음'으로 실패하는 일이 있어,
   * 그때는 Page.getResourceContent(처음 받은 그대로의 내용)로 한 번 더 받는다
   */
  private async readBody(
    entry: NetworkEntry,
    requestId: string,
    sessionId?: string
  ): Promise<{ body: string; base64Encoded: boolean }> {
    try {
      const r = (await this.cmd('Network.getResponseBody', { requestId }, sessionId)) as CdpParams
      return { body: String(r?.body ?? ''), base64Encoded: r?.base64Encoded === true }
    } catch (e) {
      const frame = this.frameOf.get(entry.key)
      if (entry.resourceType !== 'document' || !frame) throw e
      const r = (await this.cmd(
        'Page.getResourceContent',
        { frameId: frame.frameId, url: frame.url },
        sessionId
      )) as CdpParams
      return { body: String(r?.content ?? ''), base64Encoded: r?.base64Encoded === true }
    }
  }

  private detachListeners(): void {
    if (this.onMessage) this.dbg.removeListener('message', this.onMessage)
    if (this.onDetach) this.dbg.removeListener('detach', this.onDetach)
    this.onMessage = null
    this.onDetach = null
  }
}

/** 목록 한 줄 */
export function formatRow(e: NetworkEntry): string {
  const bodies = `${e.reqBody && e.reqBody !== OMITTED ? ' req-body' : ''}${e.resBody && e.resBody !== OMITTED ? ' res-body' : ''}${e.sensitive ? ' sensitive' : ''}${e.intercepted ? ' INTERCEPTED' : ''}`
  const status = e.failed ? `FAILED(${e.failed})` : (e.status ?? (e.finished ? '-' : '...'))
  return `#${e.index} ${e.method} ${status} ${e.resourceType}${e.mime ? ` ${e.mime.split(';')[0]}` : ''} ${e.durationMs ?? '?'}ms${e.fromCache ? ' cached' : ''}${bodies} ${clip(e.url, 220)}`
}
