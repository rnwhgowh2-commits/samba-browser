import { describe, it, expect, vi } from 'vitest'
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

vi.mock('../src/main/browser/page-bridge', () => ({
  pageBridge: {
    // 결제 비밀번호 키패드 판정 — 기본은 '평범한 화면'
    keypadSignals: vi.fn(async () => ({
      url: 'https://shop.example/',
      text: '',
      digitButtons: 0,
      pinField: false
    })),
    snapshot: vi.fn(),
    textOf: vi.fn(async () => ''),
    click: vi.fn(async () => 'ok'),
    type: vi.fn(async () => 'ok'),
    select: vi.fn(async () => 'ok'),
    scroll: vi.fn(async () => 'ok'),
    waitForLoad: vi.fn(async () => {})
  }
}))

const { createSambaTools } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')

type ImageBlock = { type: 'image'; data: string; mimeType: string }
type TextBlock = { type: 'text'; text: string }
interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: (ImageBlock | TextBlock)[] }>
}

// NativeImage 흉내: resize 는 자기 자신을 돌려주고(테스트에서 크기 계산은 중요하지 않음),
// toJPEG 는 임의의 버퍼를 돌려준다
function fakeNativeImage(
  w: number,
  h: number
): {
  getSize: () => { width: number; height: number }
  resize: (opts: { width?: number; height?: number }) => ReturnType<typeof fakeNativeImage>
  toJPEG: (quality: number) => Buffer
} {
  return {
    getSize: () => ({ width: w, height: h }),
    resize: (opts) => fakeNativeImage(opts.width ?? w, opts.height ?? h),
    toJPEG: () => Buffer.from('fake-jpeg-bytes')
  }
}

function build(opts: {
  mode?: ToolContext['mode']
  hasTab?: boolean
  bounds?: { width: number; height: number }
  capturePage?: () => Promise<ReturnType<typeof fakeNativeImage>>
  repaintResult?: boolean
}): {
  tools: ToolStub[]
  steps: Array<{ label: string; ok: boolean }>
  repaint: ReturnType<typeof vi.fn>
  front: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
} {
  const bounds = opts.bounds ?? { width: 800, height: 600 }
  const capturePage = opts.capturePage ?? (async () => fakeNativeImage(2560, 1440))
  const fakeTab = {
    id: 't1',
    view: {
      getBounds: () => ({ x: 0, y: 0, ...bounds }),
      webContents: {
        getURL: () => 'https://shop.example/cart',
        capturePage
      }
    },
    profile: 'default',
    mobile: false
  }
  const steps: Array<{ label: string; ok: boolean }> = []
  const repaint = vi.fn(() => opts.repaintResult ?? true)
  const front = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn())
  const capture = vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn())
  const tabs = {
    withFront: front,
    withCapture: capture,
    repaintTab: repaint,
    active: () => (opts.hasTab === false ? null : fakeTab),
    create: vi.fn(),
    activate: vi.fn(),
    list: () => [],
    navigate: vi.fn(async () => {})
  } as unknown as TabManager
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: opts.mode ?? 'guard',
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: (label, ok) => steps.push({ label, ok })
  }
  const server = createSambaTools(ctx) as unknown as { tools: ToolStub[] }
  return { tools: server.tools, steps, repaint, front, capture }
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!

describe('screenshot 도구', () => {
  it('스크롤도 앞 층에서 실행하고 완료 후 복원을 기다린다', async () => {
    const { tools, front } = build({})
    let restored = false
    const { pageBridge } = await import('../src/main/browser/page-bridge')
    front.mockImplementationOnce(async (_id, fn) => {
      expect(pageBridge.scroll).not.toHaveBeenCalled()
      const result = await fn()
      expect(pageBridge.scroll).toHaveBeenCalled()
      restored = true
      return result
    })
    vi.mocked(pageBridge.scroll).mockClear()
    await get(tools, 'scroll').handler({ direction: 'down' })
    expect(front).toHaveBeenCalledWith('t1', expect.any(Function))
    expect(restored).toBe(true)
  })
  it('활성 탭을 캡처해 image 블록과 text 블록을 함께 돌려준다', async () => {
    const { tools, steps, capture, front } = build({})
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toHaveLength(2)
    const image = r.content.find((c): c is ImageBlock => c.type === 'image')
    const textBlock = r.content.find((c): c is TextBlock => c.type === 'text')
    expect(image).toBeDefined()
    expect(image!.mimeType).toBe('image/jpeg')
    expect(image!.data.length).toBeGreaterThan(0)
    expect(textBlock).toBeDefined()
    expect(textBlock!.text).toContain('shop.example')
    expect(steps.at(-1)).toEqual({ label: '화면 캡처', ok: true })
    expect(capture).toHaveBeenCalledWith('t1', expect.any(Function))
    expect(front).not.toHaveBeenCalled()
  })

  it('read_only 모드에서도 허용된다', async () => {
    const { tools } = build({ mode: 'read_only' })
    const r = await get(tools, 'screenshot').handler({})
    const image = r.content.find((c): c is ImageBlock => c.type === 'image')
    expect(image).toBeDefined()
    expect(image!.data.length).toBeGreaterThan(0)
  })

  it('활성 탭이 없으면 no visible page 를 돌려준다', async () => {
    const { tools, steps } = build({ hasTab: false })
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toEqual([{ type: 'text', text: 'no visible page' }])
    expect(steps.at(-1)).toEqual({ label: '화면 캡처', ok: false })
  })

  it('웹뷰가 접혀(bounds 0) 있으면 no visible page 를 돌려준다(키마스터 페이지)', async () => {
    const { tools } = build({ bounds: { width: 0, height: 0 } })
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toEqual([{ type: 'text', text: 'no visible page' }])
  })

  it('캡처가 시간 안에 안 돌아오면(안 그려지는 탭) 보이는 탭을 다시 그리고 오류로 돌려준다', async () => {
    vi.useFakeTimers()
    try {
      const { tools, steps, repaint } = build({ capturePage: () => new Promise(() => {}) })
      const pending = get(tools, 'screenshot').handler({})
      await vi.advanceTimersByTimeAsync(21_000)
      const r = await pending
      expect(r.content).toHaveLength(1)
      expect((r.content[0] as TextBlock).text).toContain('timed out')
      expect(repaint).toHaveBeenCalledWith('t1', 'capture-timeout')
      expect((r.content[0] as TextBlock).text).toContain('was repainted')
      expect(steps.at(-1)).toEqual({ label: '화면 캡처', ok: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('다시 그릴 수 없는 대상(팝업·죽은 탭)이면 복구했다고 안내하지 않는다', async () => {
    vi.useFakeTimers()
    try {
      const { tools } = build({ capturePage: () => new Promise(() => {}), repaintResult: false })
      const pending = get(tools, 'screenshot').handler({})
      await vi.advanceTimersByTimeAsync(21_000)
      const r = await pending
      const msg = (r.content[0] as TextBlock).text
      expect(msg).toContain('timed out')
      expect(msg).toContain('could not be repainted')
      expect(msg).not.toContain('was repainted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('정상 캡처는 다시 그리기를 부르지 않는다', async () => {
    const { tools, repaint } = build({})
    await get(tools, 'screenshot').handler({})
    expect(repaint).not.toHaveBeenCalled()
  })

  it.each([
    [0, 0],
    [0, 600],
    [800, 0]
  ])('빈 이미지 %ix%i를 성공으로 반환하지 않는다', async (w, h) => {
    const { tools, steps, repaint } = build({ capturePage: async () => fakeNativeImage(w, h) })
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toEqual([
      {
        type: 'text',
        text: 'error: screenshot is empty - the display surface is not ready. Try again.'
      }
    ])
    expect(repaint).toHaveBeenCalledWith('t1', 'capture-empty')
    expect(steps.at(-1)).toEqual({ label: '화면 캡처', ok: false })
  })

  it('크기가 있어도 JPEG가 비어 있으면 성공으로 반환하지 않는다', async () => {
    const image = fakeNativeImage(800, 600)
    image.toJPEG = () => Buffer.alloc(0)
    const { tools, steps } = build({ capturePage: async () => image })
    const r = await get(tools, 'screenshot').handler({})
    expect(r.content).toEqual([{ type: 'text', text: 'error: screenshot could not be encoded' }])
    expect(steps.at(-1)).toEqual({ label: '화면 캡처', ok: false })
  })
})
