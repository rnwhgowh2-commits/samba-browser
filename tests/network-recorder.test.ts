import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { NetworkRecorder, formatRow, type CdpLike } from '../src/main/browser/network-recorder'

// CDP 대역: 명령은 기록하고 응답을 돌려주며, 이벤트는 테스트가 직접 쏜다
class FakeCdp extends EventEmitter implements CdpLike {
  commands: Array<{ method: string; params?: object; sessionId?: string }> = []
  bodies = new Map<string, { body: string; base64Encoded?: boolean }>()
  posts = new Map<string, string>()
  sendCommand = vi.fn(async (method: string, params?: object, sessionId?: string) => {
    // Electron 은 빈 sessionId 를 받으면 'Empty session id is not allowed' 로 거부한다
    if (sessionId === '') throw new Error('Empty session id is not allowed')
    this.commands.push({ method, params, sessionId })
    const requestId = (params as { requestId?: string } | undefined)?.requestId ?? ''
    if (method === 'Network.getResponseBody') {
      const b = this.bodies.get(requestId)
      if (!b) throw new Error('No resource with given identifier found')
      return b
    }
    if (method === 'Network.getRequestPostData')
      return { postData: this.posts.get(requestId) ?? '' }
    return {}
  })
  emitCdp(method: string, params: object, sessionId?: string): void {
    // Electron 은 메인 세션의 sessionId 를 빈 문자열로 준다
    this.emit('message', {}, method, params, sessionId ?? '')
  }
}

function xhr(
  d: FakeCdp,
  id: string,
  url: string,
  opts: {
    method?: string
    status?: number
    mime?: string
    body?: string
    post?: string
    ts?: number
    type?: string
    sessionId?: string
  } = {}
): void {
  const ts = opts.ts ?? 100
  d.emitCdp(
    'Network.requestWillBeSent',
    {
      requestId: id,
      documentURL: 'https://shop.example/p/1',
      timestamp: ts,
      wallTime: 1_700_000_000,
      type: opts.type ?? 'XHR',
      initiator: {
        type: 'script',
        stack: { callFrames: [{ url: 'https://shop.example/app.js', lineNumber: 41 }] }
      },
      request: {
        url,
        method: opts.method ?? 'GET',
        headers: { Accept: 'application/json', Cookie: 'sid=SECRET' },
        ...(opts.post !== undefined ? { postData: opts.post } : {})
      }
    },
    opts.sessionId
  )
  d.emitCdp(
    'Network.responseReceived',
    {
      requestId: id,
      type: opts.type ?? 'XHR',
      response: {
        url,
        status: opts.status ?? 200,
        statusText: 'OK',
        mimeType: opts.mime ?? 'application/json',
        headers: { 'Set-Cookie': 'a=b', 'Content-Type': opts.mime ?? 'application/json' },
        protocol: 'h2'
      }
    },
    opts.sessionId
  )
  d.emitCdp(
    'Network.loadingFinished',
    { requestId: id, timestamp: ts + 0.25, encodedDataLength: (opts.body ?? '').length },
    opts.sessionId
  )
}

describe('NetworkRecorder', () => {
  it('start 하면 Network.enable 을 보내고 요청·응답·본문을 기록한다', async () => {
    const d = new FakeCdp()
    d.bodies.set('r1', { body: JSON.stringify({ goodsNo: 'A1', price: 1000, accessToken: 'tok' }) })
    const rec = new NetworkRecorder(d)
    await rec.start()
    expect(d.commands.map((c) => c.method)).toContain('Network.enable')
    xhr(d, 'r1', 'https://shop.example/api/goods/A1', { body: '{"goodsNo":"A1"}' })
    await rec.settle()
    const { rows, total } = rec.list()
    expect(total).toBe(1)
    const e = rows[0]
    expect(e).toMatchObject({
      method: 'GET',
      status: 200,
      resourceType: 'xhr',
      mime: 'application/json',
      durationMs: 250
    })
    expect(e.initiator.top).toBe('https://shop.example/app.js:42')
    // 비밀 가림
    expect(e.reqHeaders.Cookie).toBe('<masked>')
    expect(e.resHeaders['Set-Cookie']).toBe('<masked>')
    expect(e.reqHeaders.Accept).toBe('application/json')
    const body = JSON.parse(e.resBody ?? '{}')
    expect(body.goodsNo).toBe('A1')
    expect(body.accessToken).toBe('<masked>')
    expect(formatRow(e)).toContain('#1 GET 200 xhr application/json 250ms')
  })

  it('로그인 주소는 본문을 받지도 싣지도 않는다', async () => {
    const d = new FakeCdp()
    d.bodies.set('r1', { body: '{"ok":true,"refresh":"zzz"}' })
    const rec = new NetworkRecorder(d)
    await rec.start()
    xhr(d, 'r1', 'https://shop.example/member/login.do', {
      method: 'POST',
      post: 'id=a&password=pw1',
      body: '{}'
    })
    await rec.settle()
    const e = rec.get(1)!
    expect(e.sensitive).toBe(true)
    expect(e.reqBody).toContain('omitted')
    expect(e.resBody).toContain('omitted')
    expect(JSON.stringify(e)).not.toContain('pw1')
    expect(JSON.stringify(e)).not.toContain('zzz')
    expect(d.commands.map((c) => c.method)).not.toContain('Network.getResponseBody')
  })

  it('요청 본문의 비밀 필드를 가린다', async () => {
    const d = new FakeCdp()
    d.bodies.set('r1', { body: '{}' })
    const rec = new NetworkRecorder(d)
    await rec.start()
    xhr(d, 'r1', 'https://shop.example/api/cart', {
      method: 'POST',
      post: '{"goodsNo":"A1","qty":2,"password":"pw"}',
      body: '{}'
    })
    await rec.settle()
    const e = rec.get(1)!
    expect(e.reqBody).toContain('"goodsNo":"A1"')
    expect(e.reqBody).not.toContain('"pw"')
  })

  it('큰 요청 본문은 getRequestPostData 로 받아 온다', async () => {
    const d = new FakeCdp()
    d.posts.set('r1', 'a=1&b=2')
    d.bodies.set('r1', { body: '{}' })
    const rec = new NetworkRecorder(d)
    await rec.start()
    d.emitCdp('Network.requestWillBeSent', {
      requestId: 'r1',
      timestamp: 1,
      type: 'XHR',
      request: {
        url: 'https://shop.example/api/x',
        method: 'POST',
        headers: {},
        hasPostData: true
      }
    })
    d.emitCdp('Network.responseReceived', {
      requestId: 'r1',
      type: 'XHR',
      response: { status: 200, mimeType: 'application/json', headers: {} }
    })
    d.emitCdp('Network.loadingFinished', { requestId: 'r1', timestamp: 2, encodedDataLength: 2 })
    await rec.settle()
    expect(rec.get(1)!.reqBody).toBe('a=1&b=2')
  })

  it('이미지·폰트는 기본 목록에서 빠지고 types=all 이면 보인다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    xhr(d, 'i1', 'https://shop.example/a.png', { type: 'Image', mime: 'image/png' })
    xhr(d, 'x1', 'https://shop.example/api/a', { body: '{}' })
    await rec.settle()
    expect(rec.list().total).toBe(1)
    expect(rec.list({ types: ['all'] }).total).toBe(2)
    expect(rec.list({ types: ['image'] }).rows[0].url).toContain('a.png')
  })

  it('url 필터·메서드·최소 상태로 거른다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    xhr(d, 'a', 'https://shop.example/api/goods/1', { body: '{}' })
    xhr(d, 'b', 'https://shop.example/api/price', { method: 'POST', status: 500, body: '{}' })
    await rec.settle()
    expect(rec.list({ filter: 'PRICE' }).total).toBe(1)
    expect(rec.list({ method: 'post' }).total).toBe(1)
    expect(rec.list({ minStatus: 400 }).rows[0].status).toBe(500)
  })

  it('기록 시점 url 필터에 안 맞는 요청은 쌓지 않는다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start('/api/')
    xhr(d, 'a', 'https://shop.example/static/x.js', { type: 'Script', mime: 'text/javascript' })
    xhr(d, 'b', 'https://shop.example/api/y', { body: '{}' })
    await rec.settle()
    expect(rec.status().count).toBe(1)
  })

  it('리다이렉트는 앞 항목을 닫고 새 항목을 만든다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    d.emitCdp('Network.requestWillBeSent', {
      requestId: 'r',
      timestamp: 1,
      type: 'Document',
      request: { url: 'https://shop.example/old', method: 'GET', headers: {} }
    })
    d.emitCdp('Network.requestWillBeSent', {
      requestId: 'r',
      timestamp: 1.1,
      type: 'Document',
      redirectResponse: { status: 302, statusText: 'Found' },
      request: { url: 'https://shop.example/new', method: 'GET', headers: {} }
    })
    const first = rec.get(1)!
    expect(first.status).toBe(302)
    expect(first.redirectTo).toBe('https://shop.example/new')
    expect(rec.get(2)!.url).toBe('https://shop.example/new')
  })

  it('실패한 요청은 failed 에 사유가 남는다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    d.emitCdp('Network.requestWillBeSent', {
      requestId: 'f',
      timestamp: 1,
      type: 'Fetch',
      request: { url: 'https://shop.example/api/z', method: 'GET', headers: {} }
    })
    d.emitCdp('Network.loadingFailed', {
      requestId: 'f',
      timestamp: 1.5,
      errorText: 'net::ERR_BLOCKED_BY_CLIENT'
    })
    expect(rec.get(1)!.failed).toBe('net::ERR_BLOCKED_BY_CLIENT')
    expect(formatRow(rec.get(1)!)).toContain('FAILED(net::ERR_BLOCKED_BY_CLIENT)')
  })

  it('보관 상한을 넘으면 오래된 것부터 버린다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d, { maxEntries: 3 })
    await rec.start()
    for (let i = 1; i <= 5; i++) xhr(d, `r${i}`, `https://shop.example/api/${i}`, { body: '{}' })
    await rec.settle()
    expect(rec.status().count).toBe(3)
    expect(rec.get(1)).toBeUndefined()
    expect(rec.get(5)).toBeDefined()
  })

  it('이진 응답은 본문을 두지 않고 사유를 남긴다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    xhr(d, 'b', 'https://shop.example/api/bin', { mime: 'application/octet-stream', body: 'xx' })
    await rec.settle()
    const e = rec.get(1)!
    expect(e.resBody).toBeNull()
    expect(e.resBodyNote).toContain('mime')
  })

  it('다른 사이트 iframe(자식 세션)의 요청도 기록한다', async () => {
    const d = new FakeCdp()
    d.bodies.set('c1', { body: '{"k":1}' })
    const rec = new NetworkRecorder(d)
    await rec.start()
    d.emitCdp('Target.attachedToTarget', {
      sessionId: 'S1',
      targetInfo: { type: 'iframe', url: 'https://pay.example/' }
    })
    await new Promise((r) => setTimeout(r, 0))
    const enabledChild = d.commands.find(
      (c) => c.method === 'Network.enable' && c.sessionId === 'S1'
    )
    expect(enabledChild).toBeDefined()
    xhr(d, 'c1', 'https://other.example/api/in-iframe', { body: '{"k":1}', sessionId: 'S1' })
    await rec.settle()
    expect(rec.list().rows[0].url).toBe('https://other.example/api/in-iframe')
    // 같은 requestId 라도 세션이 다르면 다른 요청이다
    xhr(d, 'c1', 'https://shop.example/api/main', { body: '{}' })
    expect(rec.status().count).toBe(2)
  })

  it('stop 하면 Network.disable 을 보내고 기록은 남는다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    xhr(d, 'a', 'https://shop.example/api/a', { body: '{}' })
    await rec.stop()
    expect(rec.isActive).toBe(false)
    expect(d.commands.map((c) => c.method)).toContain('Network.disable')
    expect(rec.list().total).toBe(1)
    // 멈춘 뒤 이벤트는 무시한다
    xhr(d, 'b', 'https://shop.example/api/b', { body: '{}' })
    expect(rec.status().count).toBe(1)
    expect(d.listenerCount('message')).toBe(0)
  })

  it('디버거가 떨어지면 기록을 멈춘 것으로 표시한다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    d.emit('detach', {}, 'target closed')
    expect(rec.isActive).toBe(false)
    expect(rec.status().stopReason).toContain('target closed')
  })

  it('Network.enable 이 실패하면 예외를 던지고 리스너를 거둔다', async () => {
    const d = new FakeCdp()
    d.sendCommand.mockRejectedValueOnce(new Error('boom'))
    const rec = new NetworkRecorder(d)
    await expect(rec.start()).rejects.toThrow('boom')
    expect(rec.isActive).toBe(false)
    expect(d.listenerCount('message')).toBe(0)
  })

  it('쿼리의 토큰 값은 주소 기록에서도 가린다', async () => {
    const d = new FakeCdp()
    const rec = new NetworkRecorder(d)
    await rec.start()
    xhr(d, 'a', 'https://shop.example/api/a?goodsNo=1&accessToken=SECRETVALUE', { body: '{}' })
    expect(rec.get(1)!.url).not.toContain('SECRETVALUE')
    expect(rec.get(1)!.url).toContain('goodsNo=1')
  })
})
