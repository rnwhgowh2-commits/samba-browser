import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/main/agent/tools'
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _d: string, _s: unknown, handler: unknown) => ({ name, handler })
}))
import { createAccountTools } from '../src/main/agent/tools-accounts'

function build(
  mode: ToolContext['mode'] = 'full',
  url = 'https://www.lemouton.co.kr/myshop/order/list.html'
): {
  ctx: ToolContext
  registerSiteAccount: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
  call: () => Promise<string>
} {
  const registerSiteAccount = vi.fn(() => ({
    host: 'lemouton.co.kr',
    label: '르무통',
    itemTypes: ['login'],
    agentAccess: 'inherit'
  }))
  const navigate = vi.fn()
  const confirm = vi.fn(async () => true)
  const ctx = {
    mode,
    tabs: { active: () => ({ view: { webContents: { getURL: () => url } } }), navigate },
    vault: { state: () => 'unlocked', registerSiteAccount },
    confirm
  } as unknown as ToolContext
  const run = async (
    _label: string,
    fn: () => Promise<string>
  ): Promise<{ content: [{ type: 'text'; text: string }] }> => ({
    content: [{ type: 'text' as const, text: await fn() }] as [{ type: 'text'; text: string }]
  })
  const tool = createAccountTools(ctx, run)[0] as unknown as {
    handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
  }
  return {
    ctx,
    registerSiteAccount,
    navigate,
    confirm,
    call: async () =>
      (
        await tool.handler({
          siteName: '르무통',
          sourceHost: 'naver.com',
          sourceAccountLabel: '구매계정'
        })
      ).content[0].text
  }
}
describe('register_site_account', () => {
  it('현재 사이트만 등록하고 페이지·세션을 이동하지 않으며 결과에 비밀을 넣지 않는다', async () => {
    const b = build()
    const result = JSON.parse(await b.call())
    expect(result).toMatchObject({ ok: true, linked: true, sessionPreserved: true })
    expect(b.navigate).not.toHaveBeenCalled()
    expect(b.registerSiteAccount.mock.calls[0][0]).toMatchObject({
      url: 'https://www.lemouton.co.kr/myshop/order/list.html'
    })
  })
  it('읽기 전용·HTTP·제외 사이트에서는 저장을 호출하지 않는다', async () => {
    for (const b of [build('read_only'), build('full', 'http://lemouton.co.kr/')]) {
      expect(await b.call()).toContain('refused')
      expect(b.registerSiteAccount).not.toHaveBeenCalled()
    }
    const b = build()
    b.ctx.vaultExcludedHosts = ['lemouton.co.kr']
    expect(await b.call()).toContain('refused')
    expect(b.registerSiteAccount).not.toHaveBeenCalled()
  })
  it('가드 모드에서 거절되면 저장하지 않는다', async () => {
    const b = build('guard')
    b.confirm.mockResolvedValue(false)
    expect(await b.call()).toBe('denied by user')
    expect(b.registerSiteAccount).not.toHaveBeenCalled()
  })
})
