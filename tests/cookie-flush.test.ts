import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  COOKIE_FLUSH_INTERVAL_MS,
  flushAllCookieStores,
  registerCookieFlush,
  resetCookieFlushForTest
} from '../src/main/browser/session-cookies'

function fakeSession(fail = false): { cookies: { flushStore: ReturnType<typeof vi.fn> } } {
  return {
    cookies: {
      flushStore: vi.fn(async () => {
        if (fail) throw new Error('disk')
      })
    }
  }
}

describe('쿠키 저장소 주기 저장', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetCookieFlushForTest()
  })
  afterEach(() => {
    resetCookieFlushForTest()
    vi.useRealTimers()
  })

  it('등록한 모든 파티션을 주기마다 디스크에 내린다', async () => {
    const a = fakeSession()
    const b = fakeSession()
    registerCookieFlush(a)
    registerCookieFlush(b)
    await vi.advanceTimersByTimeAsync(COOKIE_FLUSH_INTERVAL_MS)
    expect(a.cookies.flushStore).toHaveBeenCalledTimes(1)
    expect(b.cookies.flushStore).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(COOKIE_FLUSH_INTERVAL_MS * 2)
    expect(a.cookies.flushStore).toHaveBeenCalledTimes(3)
  })

  it('타이머는 하나만 돌고 같은 세션을 두 번 등록해도 한 번씩만 쓴다', async () => {
    const a = fakeSession()
    registerCookieFlush(a)
    registerCookieFlush(a)
    await vi.advanceTimersByTimeAsync(COOKIE_FLUSH_INTERVAL_MS)
    expect(a.cookies.flushStore).toHaveBeenCalledTimes(1)
  })

  it('한 파티션이 실패해도 나머지는 계속 쓰고 실패 개수를 돌려준다', async () => {
    const bad = fakeSession(true)
    const ok = fakeSession()
    registerCookieFlush(bad)
    registerCookieFlush(ok)
    expect(await flushAllCookieStores()).toBe(1)
    expect(ok.cookies.flushStore).toHaveBeenCalled()
  })

  it('저장이 끝나지 않는 파티션이 있어도 호출이 쌓이지 않고 나머지 파티션은 그 주기에 저장된다', async () => {
    const stuck = { cookies: { flushStore: vi.fn(() => new Promise<void>(() => {})) } }
    const ok = fakeSession()
    registerCookieFlush(stuck)
    registerCookieFlush(ok)
    await vi.advanceTimersByTimeAsync(COOKIE_FLUSH_INTERVAL_MS * 3)
    // 첫 저장이 끝나지 않았으므로 새 저장을 시작하지 않는다(미완료 호출 1개), 다른 파티션은 첫 주기에 저장됐다
    expect(stuck.cookies.flushStore).toHaveBeenCalledTimes(1)
    expect(ok.cookies.flushStore).toHaveBeenCalledTimes(1)
  })

  it('저장 실패는 로그로 남기되 같은 상태가 계속되면 반복해서 쓰지 않는다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = fakeSession(true)
    registerCookieFlush(bad)
    await vi.advanceTimersByTimeAsync(COOKIE_FLUSH_INTERVAL_MS * 3)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('실패 1/1')
    warn.mockRestore()
  })
})
