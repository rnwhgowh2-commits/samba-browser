import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'

// SDK 의 tool()/createSdkMcpServer() 를 얇게 대체해 도구 핸들러를 직접 부를 수 있게 한다
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: unknown) => o
}))

const { pageBridge } = vi.hoisted(() => ({
  pageBridge: {
    // 결제 비밀번호 키패드 판정 — 기본은 '평범한 화면'
    keypadSignals: vi.fn(async () => ({
      url: 'https://shop.example/',
      text: '',
      digitButtons: 0,
      pinField: false
    }))
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools, SAMBA_TOOL_NAMES } = await import('../src/main/agent/tools')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>
}

class FakeDebugger extends EventEmitter {
  attached = false
  commands: string[] = []
  bodies: Record<string, string> = {}
  attach = vi.fn(() => {
    this.attached = true
  })
  isAttached = (): boolean => this.attached
  detach = vi.fn()
  sendCommand = vi.fn(async (method: string, params?: { requestId?: string }) => {
    this.commands.push(method)
    if (method === 'Network.getResponseBody')
      return { body: this.bodies[params?.requestId ?? ''] ?? '' }
    return {}
  })
  fire(method: string, params: object): void {
    this.emit('message', {}, method, params)
  }
}

function build(opts: { url?: string; hasTab?: boolean; mode?: ToolContext['mode'] } = {}): {
  tools: ToolStub[]
  dbg: FakeDebugger
} {
  const dbg = new FakeDebugger()
  const url = opts.url ?? 'https://shop.example/p/1'
  const fakeTab = {
    id: 't1',
    view: {
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      webContents: {
        debugger: dbg,
        getURL: () => url,
        isDestroyed: () => false,
        isCrashed: () => false
      }
    }
  }
  const tabs = {
    active: () => (opts.hasTab === false ? null : fakeTab),
    list: () => []
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: [],
    mode: opts.mode ?? 'read_only',
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: () => {}
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, dbg }
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!
const text = (r: { content: { text: string }[] }): string => r.content[0].text

function request(dbg: FakeDebugger, id: string, url: string, body: string): void {
  dbg.bodies[id] = body
  dbg.fire('Network.requestWillBeSent', {
    requestId: id,
    timestamp: 10,
    type: 'XHR',
    request: { url, method: 'GET', headers: { Cookie: 'sid=SECRET', Accept: 'application/json' } }
  })
  dbg.fire('Network.responseReceived', {
    requestId: id,
    type: 'XHR',
    response: { status: 200, mimeType: 'application/json', headers: {} }
  })
  dbg.fire('Network.loadingFinished', {
    requestId: id,
    timestamp: 10.2,
    encodedDataLength: body.length
  })
}

describe('네트워크 기록 도구', () => {
  it('도구 3개가 목록과 허용 이름에 있다', () => {
    const { tools } = build()
    for (const n of ['network_record', 'network_list', 'network_get'])
      expect(tools.map((t) => t.name)).toContain(n)
    for (const n of ['network_record', 'network_list', 'network_get'])
      expect(SAMBA_TOOL_NAMES).toContain(`mcp__samba__${n}`)
  })

  it('start → 요청 → list → get 흐름 (read_only 모드에서도)', async () => {
    const { tools, dbg } = build({ mode: 'read_only' })
    const started = text(await get(tools, 'network_record').handler({ action: 'start' }))
    expect(started).toContain('ok: recording')
    expect(dbg.commands).toContain('Network.enable')

    request(
      dbg,
      'r1',
      'https://shop.example/api/goods/A1?accessToken=ZZZ',
      '{"goodsNo":"A1","price":1000}'
    )

    const listed = text(await get(tools, 'network_list').handler({}))
    expect(listed).toContain('matched=1')
    expect(listed).toContain('#1 GET 200 xhr application/json')
    expect(listed).not.toContain('ZZZ')

    const detail = text(await get(tools, 'network_get').handler({ index: 1 }))
    expect(detail).toContain('goodsNo')
    expect(detail).toContain('A1')
    expect(detail).toContain('<masked>') // Cookie 값
    expect(detail).not.toContain('SECRET')
    expect(detail).not.toContain('ZZZ')
  })

  it('start 전에는 list·get 이 안내 문구를 돌려준다', async () => {
    const { tools } = build()
    expect(text(await get(tools, 'network_list').handler({}))).toContain('network_record start')
    expect(text(await get(tools, 'network_get').handler({ index: 1 }))).toContain(
      'network_record start'
    )
  })

  it('없는 번호는 not found', async () => {
    const { tools } = build()
    await get(tools, 'network_record').handler({ action: 'start' })
    expect(text(await get(tools, 'network_get').handler({ index: 99 }))).toContain('not found')
  })

  it('stop 뒤에도 기록은 읽을 수 있고 status 가 멈춤을 알린다', async () => {
    const { tools, dbg } = build()
    await get(tools, 'network_record').handler({ action: 'start' })
    request(dbg, 'r1', 'https://shop.example/api/a', '{}')
    const stopped = text(await get(tools, 'network_record').handler({ action: 'stop' }))
    expect(stopped).toContain('ok: stopped')
    expect(dbg.commands).toContain('Network.disable')
    expect(text(await get(tools, 'network_list').handler({}))).toContain('matched=1')
    const status = JSON.parse(
      text(await get(tools, 'network_record').handler({ action: 'status' }))
    )
    expect(status.active).toBe(false)
  })

  it('clear 는 목록을 비운다', async () => {
    const { tools, dbg } = build()
    await get(tools, 'network_record').handler({ action: 'start' })
    request(dbg, 'r1', 'https://shop.example/api/a', '{}')
    await get(tools, 'network_record').handler({ action: 'clear' })
    expect(text(await get(tools, 'network_list').handler({}))).toContain('no matching requests')
  })

  it('활성 탭이 없으면 no active tab', async () => {
    const { tools } = build({ hasTab: false })
    expect(text(await get(tools, 'network_record').handler({ action: 'start' }))).toBe(
      'no active tab'
    )
  })

  it('결제 비밀번호 키패드 화면에서는 기록을 시작하지 않는다', async () => {
    const { tools, dbg } = build({ url: 'https://bill.payco.com/paymentPopup/password/confirm' })
    const r = text(await get(tools, 'network_record').handler({ action: 'start' }))
    expect(r).toBe('refused: secret screen')
    expect(dbg.commands).not.toContain('Network.enable')
  })

  it('url_filter 로 시작하면 맞는 요청만 쌓는다', async () => {
    const { tools, dbg } = build()
    await get(tools, 'network_record').handler({ action: 'start', url_filter: '/api/' })
    request(dbg, 'a', 'https://shop.example/static/app.js', '{}')
    request(dbg, 'b', 'https://shop.example/api/b', '{}')
    expect(text(await get(tools, 'network_list').handler({ types: 'all' }))).toContain('matched=1')
  })
})
