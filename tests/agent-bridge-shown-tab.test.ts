// 브릿지(외부 세션·하네스) 호출이 사람이 보고 있는 탭을 다른 주소로 옮기지 않는지(실기 2026-10-24~25:
// 보던 탭이 다른 소싱처로 바뀜). navigate·login 은 보이는 탭이면 같은 프로필의 새 탭을 뒤에서 열어 거기서 일한다

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TabManager } from '../src/main/browser/tab-manager'
import type { ToolContext } from '../src/main/agent/tools'

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
    snapshot: vi.fn(),
    waitForLoad: vi.fn(async () => {})
  }
}))
vi.mock('../src/main/browser/page-bridge', () => ({ pageBridge }))

const { createSambaTools } = await import('../src/main/agent/tools')
const { DEFAULT_DANGER_WORDS } = await import('../src/shared/danger')
const { runFromBridge } = await import('../src/main/browser/human-activity')

interface ToolStub {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
}

/** 보이는 탭 shown 하나와, create 로 새 탭을 만드는 가짜 TabManager */
function fakeTabs(): { tabs: TabManager; urls: Map<string, string>; created: unknown[] } {
  const urls = new Map<string, string>([['shown', 'https://www.musinsa.com/main']])
  const created: unknown[] = []
  const tabOf = (id: string): unknown => ({
    id,
    profile: 'musinsa-1',
    mobile: false,
    view: { webContents: { getURL: () => urls.get(id) ?? '' } }
  })
  const manager = {
    list: () => [],
    listTargets: () =>
      [...urls.keys()].map((id) => ({ id, kind: 'tab', title: id, url: urls.get(id), active: id === 'shown' })),
    agentTarget: () => tabOf('shown'),
    active: () => tabOf('shown'),
    get: (id: string) => (urls.has(id) ? tabOf(id) : null),
    isShownTab: (id: string) => id === 'shown',
    create: vi.fn((opts: unknown) => {
      created.push(opts)
      urls.set('bg', 'about:blank')
      return { id: 'bg' }
    }),
    navigate: vi.fn(async (id: string, url: string) => {
      urls.set(id, url)
    })
  } as unknown as TabManager
  return { tabs: manager, urls, created }
}

function build(tabs: TabManager): ToolStub[] {
  const ctx: ToolContext = {
    tabs,
    dangerWords: DEFAULT_DANGER_WORDS,
    mode: 'guard',
    finalConfirm: false,
    confirm: vi.fn(async () => true),
    tick: () => null,
    onStep: () => undefined
  }
  return (createSambaTools(ctx) as unknown as { tools: ToolStub[] }).tools
}

const get = (tools: ToolStub[], name: string): ToolStub => tools.find((t) => t.name === name)!
const textOut = (r: { content: { text: string }[] }): string => r.content[0].text

beforeEach(() => {
  pageBridge.waitForLoad.mockClear()
})

describe('navigate — 브릿지는 보이는 탭을 옮기지 않는다', () => {
  it('브릿지 호출이면 보이는 탭은 두고 같은 프로필 새 탭을 뒤에서 열어 이동한다', async () => {
    const env = fakeTabs()
    const tools = build(env.tabs)
    const r = await runFromBridge('bridge', () =>
      get(tools, 'navigate').handler({ url: 'https://www.ssg.com/' })
    )
    expect(textOut(r)).toContain('opened in new background tab bg')
    expect(env.urls.get('shown')).toBe('https://www.musinsa.com/main')
    expect(env.urls.get('bg')).toBe('https://www.ssg.com/')
    expect(env.created).toEqual([{ url: 'about:blank', profile: 'musinsa-1', mobile: false }])
  })

  it('앱 안 AI 패널(브릿지 아님)은 예전처럼 보이는 탭을 옮긴다', async () => {
    const env = fakeTabs()
    const r = await get(build(env.tabs), 'navigate').handler({ url: 'https://www.ssg.com/' })
    expect(textOut(r)).toBe('ok: https://www.ssg.com/')
    expect(env.urls.get('shown')).toBe('https://www.ssg.com/')
    expect(env.created).toEqual([])
  })
})

describe('login — 첫 확인(평문 페이지·금고 없음)에서 거절되면 뒤 탭도 열지 않는다', () => {
  it('금고가 없어 거절되면 브릿지여도 새 탭을 만들지 않는다', async () => {
    const env = fakeTabs()
    const r = await runFromBridge('bridge', () => get(build(env.tabs), 'login').handler({}))
    expect(textOut(r)).not.toContain('signed in')
    expect(env.created).toEqual([])
    expect(env.urls.get('shown')).toBe('https://www.musinsa.com/main')
  })
})
