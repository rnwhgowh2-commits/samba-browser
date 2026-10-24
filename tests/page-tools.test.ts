import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'
import { ConsoleRecorder } from '../src/main/browser/console-recorder'
import { NetworkGuard } from '../src/main/browser/network-guard'

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
const { forbiddenCodeReason, formatEvalValue } = await import('../src/main/agent/tools-page')

class FakeDebugger extends EventEmitter {
  attached = false
  commands: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = []
  evalResult: unknown = { result: { type: 'object', value: { ok: true } } }
  attach = vi.fn(() => {
    this.attached = true
  })
  isAttached = (): boolean => this.attached
  detach = vi.fn()
  sendCommand = vi.fn(
    async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      if (sessionId === '') throw new Error('Empty session id is not allowed')
      this.commands.push({ method, params, sessionId })
      if (method === 'Runtime.evaluate') return this.evalResult
      return {}
    }
  )
  fire(method: string, params: object): void {
    this.emit('message', {}, method, params, '')
  }
}

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>
}

function build(opts: { mode?: ToolContext['mode']; confirm?: boolean; url?: string } = {}): {
  tools: ToolStub[]
  dbg: FakeDebugger
  confirm: ReturnType<typeof vi.fn>
} {
  const dbg = new FakeDebugger()
  const fakeTab = {
    id: 't1',
    view: {
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      webContents: {
        debugger: dbg,
        getURL: () => opts.url ?? 'https://shop.example/p/1',
        isDestroyed: () => false,
        isCrashed: () => false
      }
    }
  }
  const tabs = { active: () => fakeTab, list: () => [] } as unknown as TabManager
  const confirm = vi.fn(async () => opts.confirm ?? true)
  const ctx: ToolContext = {
    tabs,
    dangerWords: ['삭제', '결제'],
    mode: opts.mode ?? 'guard',
    finalConfirm: false,
    confirm,
    tick: () => null,
    onStep: () => {}
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, dbg, confirm }
}

const get = (tools: ToolStub[], n: string): ToolStub => tools.find((t) => t.name === n)!
const text = (r: { content: { text: string }[] }): string => r.content[0].text

describe('page_eval', () => {
  it('등록되어 있다', () => {
    const { tools } = build()
    for (const n of ['page_eval', 'console_read', 'network_guard']) {
      expect(tools.map((t) => t.name)).toContain(n)
      expect(SAMBA_TOOL_NAMES).toContain(`mcp__samba__${n}`)
    }
  })

  it('코드를 async 함수 몸통으로 감싸 실행하고 값을 돌려준다', async () => {
    const { tools, dbg } = build()
    dbg.evalResult = { result: { type: 'object', value: { goodsNo: 'A1', price: 1000 } } }
    const r = text(await get(tools, 'page_eval').handler({ code: 'return {goodsNo:"A1"}' }))
    expect(JSON.parse(r)).toEqual({ goodsNo: 'A1', price: 1000 })
    const call = dbg.commands.find((c) => c.method === 'Runtime.evaluate')!
    expect(String(call.params?.expression)).toContain('(async () => {')
    expect(call.params).toMatchObject({ awaitPromise: true, returnByValue: true })
  })

  it('결과의 비밀 이름 값은 가린다', async () => {
    const { tools, dbg } = build()
    dbg.evalResult = { result: { type: 'object', value: { price: 1, accessToken: 'ABCSECRET' } } }
    const r = text(await get(tools, 'page_eval').handler({ code: 'return 1' }))
    expect(r).not.toContain('ABCSECRET')
    expect(r).toContain('<masked>')
  })

  it('쿠키·저장소·비밀번호 칸·Authorization 코드는 실행하지 않는다', async () => {
    const { tools, dbg } = build()
    for (const code of [
      'return document.cookie',
      'return localStorage.getItem("t")',
      'return document.querySelector("input[type=password]").value',
      'fetch("/a",{headers:{Authorization:"x"}})'
    ]) {
      const r = text(await get(tools, 'page_eval').handler({ code }))
      expect(r).toContain('refused')
    }
    expect(dbg.commands.some((c) => c.method === 'Runtime.evaluate')).toBe(false)
  })

  it('read_only 모드에서는 거절한다', async () => {
    const { tools } = build({ mode: 'read_only' })
    expect(text(await get(tools, 'page_eval').handler({ code: 'return 1' }))).toBe(
      'refused: read-only mode'
    )
  })

  it('위험 단어가 들어 있으면 guard 모드에서 확인을 받고, 거부하면 실행하지 않는다', async () => {
    const { tools, dbg, confirm } = build({ confirm: false })
    const r = text(await get(tools, 'page_eval').handler({ code: 'return "결제"' }))
    expect(confirm).toHaveBeenCalled()
    expect(r).toBe('denied by user')
    expect(dbg.commands.some((c) => c.method === 'Runtime.evaluate')).toBe(false)
  })

  it('예외는 error: 로 돌려준다', async () => {
    const { tools, dbg } = build()
    dbg.evalResult = {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'ReferenceError: x is not defined' }
      }
    }
    expect(text(await get(tools, 'page_eval').handler({ code: 'return x' }))).toContain(
      'ReferenceError'
    )
  })

  it('결제 비밀번호 화면에서는 실행하지 않는다', async () => {
    const { tools, dbg } = build({ url: 'https://bill.payco.com/paymentPopup/password/confirm' })
    expect(text(await get(tools, 'page_eval').handler({ code: 'return 1' }))).toBe(
      'refused: secret screen'
    )
    expect(dbg.commands.some((c) => c.method === 'Runtime.evaluate')).toBe(false)
  })

  it('보조 함수', () => {
    expect(forbiddenCodeReason('return 1')).toBeNull()
    expect(forbiddenCodeReason('document.cookie')).toBe('cookies')
    expect(formatEvalValue(undefined)).toBe('undefined')
    expect(formatEvalValue('x'.repeat(9000)).length).toBeLessThan(8100)
  })
})

describe('console_read', () => {
  it('start 뒤의 콘솔·예외·로그를 읽고 비밀을 가린다', async () => {
    const { tools, dbg } = build()
    expect(text(await get(tools, 'console_read').handler({ action: 'start' }))).toContain('ok')
    expect(dbg.commands.map((c) => c.method)).toEqual(
      expect.arrayContaining(['Runtime.enable', 'Log.enable'])
    )
    dbg.fire('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'price failed token="abcdef123456"' }],
      timestamp: 1_700_000_000_000,
      stackTrace: { callFrames: [{ url: 'https://shop.example/app.js', lineNumber: 9 }] }
    })
    dbg.fire('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'hello' }]
    })
    dbg.fire('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: boom' },
        url: 'https://shop.example/a.js',
        lineNumber: 2
      }
    })
    dbg.fire('Log.entryAdded', {
      entry: {
        source: 'network',
        level: 'error',
        text: 'Failed to load resource: 404',
        url: 'https://shop.example/x'
      }
    })
    const all = text(await get(tools, 'console_read').handler({}))
    expect(all).toContain('matched=4')
    expect(all).not.toContain('abcdef123456')
    expect(all).toContain('TypeError: boom')
    expect(all).toContain('app.js:10')
    const errors = text(await get(tools, 'console_read').handler({ level: 'error' }))
    expect(errors).toContain('matched=3')
    expect(text(await get(tools, 'console_read').handler({ filter: 'hello' }))).toContain(
      'matched=1'
    )
  })

  it('start 전에는 안내 문구', async () => {
    const { tools } = build()
    expect(text(await get(tools, 'console_read').handler({}))).toContain('start')
  })

  it('stop 뒤에도 읽을 수 있고 clear 로 비운다', async () => {
    const { tools, dbg } = build()
    await get(tools, 'console_read').handler({ action: 'start' })
    dbg.fire('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ type: 'string', value: 'w' }]
    })
    await get(tools, 'console_read').handler({ action: 'stop' })
    expect(text(await get(tools, 'console_read').handler({}))).toContain('matched=1')
    await get(tools, 'console_read').handler({ action: 'clear' })
    expect(text(await get(tools, 'console_read').handler({}))).toContain('no messages')
  })
})

describe('ConsoleRecorder', () => {
  it('보관 상한을 넘으면 오래된 것부터 버린다', async () => {
    const d = new FakeDebugger()
    const rec = new ConsoleRecorder(d, 3)
    await rec.start()
    for (let i = 0; i < 5; i++)
      d.fire('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ type: 'string', value: `m${i}` }]
      })
    expect(rec.list().rows.map((r) => r.text)).toEqual(['m2', 'm3', 'm4'])
  })
})

describe('network_guard', () => {
  function paused(d: FakeDebugger, id: string, method: string, url: string, networkId = id): void {
    d.fire('Fetch.requestPaused', { requestId: id, networkId, request: { method, url } })
  }

  it('쓰기 요청은 가짜 200 으로 막고 읽기 요청은 통과시킨다', async () => {
    const { tools, dbg } = build()
    const on = text(await get(tools, 'network_guard').handler({ action: 'on' }))
    expect(on).toContain('guard ON')
    expect(dbg.commands.map((c) => c.method)).toEqual(
      expect.arrayContaining(['Fetch.enable', 'Network.enable'])
    )
    paused(dbg, 'f1', 'GET', 'https://shop.example/api/a')
    paused(dbg, 'f2', 'POST', 'https://shop.example/api/brand-create-groups')
    paused(dbg, 'f3', 'OPTIONS', 'https://shop.example/api/brand-create-groups')
    await new Promise((r) => setTimeout(r, 5))
    const methods = dbg.commands
      .filter((c) => c.method.startsWith('Fetch.'))
      .map((c) => `${c.method}:${c.params?.requestId}`)
    expect(methods).toContain('Fetch.continueRequest:f1')
    expect(methods).toContain('Fetch.fulfillRequest:f2')
    expect(methods).toContain('Fetch.continueRequest:f3')
    const ful = dbg.commands.find((c) => c.method === 'Fetch.fulfillRequest')!
    expect(ful.params).toMatchObject({ responseCode: 200 })
    expect(Buffer.from(String(ful.params?.body), 'base64').toString()).toBe('{"intercepted":true}')
    expect(
      JSON.parse(text(await get(tools, 'network_guard').handler({ action: 'status' }))).blocked
    ).toBe(1)
  })

  it('allow 에 든 주소는 쓰기여도 통과시킨다', async () => {
    const { tools, dbg } = build()
    await get(tools, 'network_guard').handler({ action: 'on', allow: '/brand-scan' })
    paused(dbg, 'f1', 'POST', 'https://shop.example/api/brand-scan')
    await new Promise((r) => setTimeout(r, 5))
    expect(
      dbg.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'f1')
    ).toBe(true)
    expect(dbg.commands.some((c) => c.method === 'Fetch.fulfillRequest')).toBe(false)
  })

  it('막힌 요청은 network_list 에 INTERCEPTED 로 보이고 본문을 읽을 수 있다', async () => {
    const { tools, dbg } = build()
    await get(tools, 'network_guard').handler({ action: 'on' })
    dbg.fire('Network.requestWillBeSent', {
      requestId: 'n1',
      timestamp: 1,
      type: 'XHR',
      request: {
        url: 'https://shop.example/api/groups',
        method: 'POST',
        headers: {},
        postData: '{"keyword":"x","brand":"b"}'
      }
    })
    paused(dbg, 'f9', 'POST', 'https://shop.example/api/groups', 'n1')
    await new Promise((r) => setTimeout(r, 5))
    const list = text(await get(tools, 'network_list').handler({}))
    expect(list).toContain('INTERCEPTED')
    const detail = text(await get(tools, 'network_get').handler({ index: 1 }))
    expect(detail).toContain('keyword')
    expect(detail).toContain('NOT sent')
  })

  it('off 하면 Fetch.disable 을 보낸다', async () => {
    const { tools, dbg } = build()
    await get(tools, 'network_guard').handler({ action: 'on' })
    const off = text(await get(tools, 'network_guard').handler({ action: 'off' }))
    expect(off).toContain('guard off')
    expect(dbg.commands.map((c) => c.method)).toContain('Fetch.disable')
    expect(
      JSON.parse(text(await get(tools, 'network_guard').handler({ action: 'status' }))).active
    ).toBe(false)
  })

  it('가드가 꺼진 뒤 일시정지된 요청은 그대로 보낸다 (페이지가 멈추지 않게)', async () => {
    const d = new FakeDebugger()
    const g = new NetworkGuard(d)
    await g.enable()
    await g.disable()
    // 리스너를 거뒀으니 이벤트에 반응하지 않는다 — 남은 일시정지는 Fetch.disable 이 풀어 준다
    expect(d.listenerCount('message')).toBe(0)
  })

  it('처리 중 오류가 나도 요청을 계속 진행시키려 한다', async () => {
    const d = new FakeDebugger()
    const g = new NetworkGuard(d)
    await g.enable()
    let first = true
    d.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      d.commands.push({ method, params })
      if (method === 'Fetch.fulfillRequest' && first) {
        first = false
        throw new Error('boom')
      }
      return {}
    })
    d.fire('Fetch.requestPaused', {
      requestId: 'z',
      request: { method: 'POST', url: 'https://a.example/x' }
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(
      d.commands.some((c) => c.method === 'Fetch.continueRequest' && c.params?.requestId === 'z')
    ).toBe(true)
  })
})
