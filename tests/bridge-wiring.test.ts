// 설정에 따라 브릿지를 켜고 끄고, 토큰이 없으면 만든다
import { describe, it, expect, vi } from 'vitest'
import { applyBridgeSettings, newBridgeToken } from '../src/main/bridge/wiring'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

function fakeServer(): {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  listening: () => boolean
  address: () => { address: string; port: number } | null
  port: number | null
} {
  const s = {
    port: null as number | null,
    start: vi.fn(async (p: number) => {
      s.port = p
      return p
    }),
    stop: vi.fn(async () => {
      s.port = null
    }),
    listening: () => s.port !== null,
    address: () => (s.port === null ? null : { address: '127.0.0.1', port: s.port })
  }
  return s
}

describe('applyBridgeSettings', () => {
  it('켜면 토큰을 만들어 저장하고 그 포트로 듣는다', async () => {
    const server = fakeServer()
    const saved: Record<string, unknown>[] = []
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: true }),
      (p) => saved.push(p)
    )
    expect(server.start).toHaveBeenCalledWith(47811)
    expect(saved).toHaveLength(1)
    expect(String(saved[0].bridgeToken)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('토큰이 이미 있으면 다시 만들지 않는다', async () => {
    const server = fakeServer()
    const saved: unknown[] = []
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }),
      (p) => saved.push(p)
    )
    expect(saved).toHaveLength(0)
  })

  it('끄면 멈추고, 포트가 바뀌면 다시 듣는다', async () => {
    const server = fakeServer()
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }),
      () => {}
    )
    await applyBridgeSettings(
      server,
      () => ({
        ...DEFAULT_SETTINGS,
        bridgeEnabled: true,
        bridgeToken: 'f'.repeat(64),
        bridgePort: 47900
      }),
      () => {}
    )
    expect(server.start).toHaveBeenLastCalledWith(47900)
    await applyBridgeSettings(
      server,
      () => ({ ...DEFAULT_SETTINGS, bridgeEnabled: false, bridgeToken: 'f'.repeat(64) }),
      () => {}
    )
    expect(server.stop).toHaveBeenCalled()
    expect(server.listening()).toBe(false)
  })

  it('호출이 겹쳐도 순서대로 처리된다(레이스 없음)', async () => {
    const server = fakeServer()
    let s = { ...DEFAULT_SETTINGS, bridgeEnabled: true, bridgeToken: 'f'.repeat(64) }
    const getSettings = (): typeof s => s
    const p1 = applyBridgeSettings(server, getSettings, () => {})
    s = { ...s, bridgePort: 48000 }
    const p2 = applyBridgeSettings(server, getSettings, () => {})
    await Promise.all([p1, p2])
    expect(server.start).toHaveBeenLastCalledWith(48000)
    expect(server.listening()).toBe(true)
  })

  it('포트가 아직 쓰이는 중이라 시작에 실패하면 잠시 뒤 다시 듣는다', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeServer()
      const real = server.start.getMockImplementation()!
      server.start.mockImplementationOnce(async () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:47811')
      })
      const getSettings = (): typeof DEFAULT_SETTINGS => ({
        ...DEFAULT_SETTINGS,
        bridgeEnabled: true,
        bridgeToken: 'f'.repeat(64)
      })
      await applyBridgeSettings(server, getSettings, () => {}, 1000)
      expect(server.listening()).toBe(false)
      server.start.mockImplementation(real)
      await vi.advanceTimersByTimeAsync(1000)
      expect(server.start).toHaveBeenCalledTimes(2)
      expect(server.listening()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('다시 듣기를 기다리는 중에 끄면 재시도하지 않는다', async () => {
    vi.useFakeTimers()
    try {
      const server = fakeServer()
      server.start.mockImplementationOnce(async () => {
        throw new Error('listen EADDRINUSE')
      })
      let enabled = true
      const getSettings = (): typeof DEFAULT_SETTINGS => ({
        ...DEFAULT_SETTINGS,
        bridgeEnabled: enabled,
        bridgeToken: 'f'.repeat(64)
      })
      await applyBridgeSettings(server, getSettings, () => {}, 1000)
      enabled = false
      await applyBridgeSettings(server, getSettings, () => {}, 1000)
      await vi.advanceTimersByTimeAsync(5000)
      expect(server.start).toHaveBeenCalledTimes(1)
      expect(server.listening()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('새 토큰은 64자 hex 다', () => {
    expect(newBridgeToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(newBridgeToken()).not.toBe(newBridgeToken())
  })
})
