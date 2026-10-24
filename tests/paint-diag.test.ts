// 탭 화면이 안 그려지는 문제의 진단 기록·복구 판정 회귀 시험(paint-diag.ts)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPTURE_TIMEOUT,
  HealGate,
  PaintDiagLog,
  isRepaintShortcut,
  shortId,
  stackMismatch,
  topTabId,
  withCaptureTimeout
} from '../src/main/browser/paint-diag'

describe('topTabId / stackMismatch — 보이는 탭이 맨 위인가', () => {
  it('탭이 아닌 뷰(null)는 건너뛰고 맨 위 탭을 찾는다', () => {
    expect(topTabId(['a', 'b', null])).toBe('b')
    expect(topTabId([null, null])).toBeNull()
    expect(topTabId([])).toBeNull()
  })

  it('보이는 탭이 맨 위이면 어긋나지 않았다(위에 확장 팝업 뷰가 있어도)', () => {
    expect(stackMismatch(['lane1', 'lane2', 'v', null], 'v')).toBe(false)
  })

  it('다른 탭이 보이는 탭 위에 있으면 어긋났다', () => {
    expect(stackMismatch(['v', 'lane1'], 'v')).toBe(true)
  })

  it('보이는 탭이 없거나 탭이 하나도 없으면 어긋남으로 보지 않는다', () => {
    expect(stackMismatch(['a'], null)).toBe(false)
    expect(stackMismatch([null], 'v')).toBe(false)
  })
})

describe('isRepaintShortcut — Ctrl+Alt+R', () => {
  const base = { type: 'keyDown', key: 'r', control: true, alt: true, shift: false, meta: false }
  it('Ctrl+Alt+R(대소문자 무관)과 Cmd+Alt+R 을 받는다', () => {
    expect(isRepaintShortcut(base)).toBe(true)
    expect(isRepaintShortcut({ ...base, key: 'R' })).toBe(true)
    expect(isRepaintShortcut({ ...base, control: false, meta: true })).toBe(true)
  })

  it('한글 입력 상태(key 가 ㄱ·Process)여도 물리 키 KeyR 이면 받는다', () => {
    expect(isRepaintShortcut({ ...base, key: 'ㄱ', code: 'KeyR' })).toBe(true)
    expect(isRepaintShortcut({ ...base, key: 'Process', code: 'KeyR' })).toBe(true)
    expect(isRepaintShortcut({ ...base, key: 'ㄴ', code: 'KeyS' })).toBe(false)
  })

  it('물리 키(code)가 오면 그것만 본다 — 다른 키가 r 로 재매핑돼 와도 가로채지 않는다', () => {
    expect(isRepaintShortcut({ ...base, key: 'r', code: 'KeyS' })).toBe(false)
  })

  it('code 가 없거나 비어 있으면 key 로 판정한다', () => {
    expect(isRepaintShortcut({ ...base, key: 'r', code: undefined })).toBe(true)
    expect(isRepaintShortcut({ ...base, key: 'R', code: '' })).toBe(true)
    expect(isRepaintShortcut({ ...base, key: 'x', code: '' })).toBe(false)
  })

  it('Alt 없음·Shift 동반·키 뗌·다른 키는 받지 않는다(확대·캡처·작업공간 단축키와 겹치지 않는다)', () => {
    expect(isRepaintShortcut({ ...base, alt: false })).toBe(false)
    expect(isRepaintShortcut({ ...base, shift: true })).toBe(false)
    expect(isRepaintShortcut({ ...base, type: 'keyUp' })).toBe(false)
    expect(isRepaintShortcut({ ...base, key: '1' })).toBe(false)
    expect(isRepaintShortcut({ ...base, control: false, meta: false })).toBe(false)
  })
})

describe('HealGate — 자동 복구 횟수 제한', () => {
  it('복구 직후 쿨다운 동안은 막고, 지나면 허용한다', () => {
    const g = new HealGate(30_000, 600_000, 5)
    expect(g.allow(0)).toBe(true)
    expect(g.allow(10_000)).toBe(false)
    expect(g.allow(30_000)).toBe(true)
  })

  it('창 안에서 최대 횟수를 넘으면 막고, 창이 지나 옛 기록이 빠지면 다시 허용한다', () => {
    const g = new HealGate(1_000, 100_000, 3)
    expect(g.allow(0)).toBe(true)
    expect(g.allow(2_000)).toBe(true)
    expect(g.allow(4_000)).toBe(true)
    expect(g.allow(6_000)).toBe(false)
    expect(g.allow(101_000)).toBe(true)
  })
})

describe('withCaptureTimeout', () => {
  afterEach(() => vi.useRealTimers())

  it('시간 안에 끝나면 값을 돌려준다', async () => {
    await expect(withCaptureTimeout(Promise.resolve(7), 1000)).resolves.toBe(7)
  })

  it('안 돌아오는 호출은 시간이 지나면 CAPTURE_TIMEOUT 을 돌려준다', async () => {
    vi.useFakeTimers()
    const p = withCaptureTimeout(new Promise<number>(() => {}), 5000)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(p).resolves.toBe(CAPTURE_TIMEOUT)
  })

  it('시간이 지난 뒤 늦게 실패해도 처리되지 않은 거부가 남지 않는다', async () => {
    vi.useFakeTimers()
    let reject: (e: Error) => void = () => {}
    const slow = new Promise<number>((_, rej) => (reject = rej))
    const p = withCaptureTimeout(slow, 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBe(CAPTURE_TIMEOUT)
    reject(new Error('late'))
    await vi.advanceTimersByTimeAsync(10)
  })
})

describe('PaintDiagLog — 한 줄 JSON 로그(모아서 비동기로 씀)', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'paint-diag-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    vi.useRealTimers()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('없는 폴더를 만들고 시각·사건·값을 한 줄 JSON 으로 남긴다', () => {
    const file = join(tmp(), 'logs', 'paint-diag.log')
    const log = new PaintDiagLog(file, 1024 * 1024, () => Date.UTC(2026, 9, 24, 8, 0, 0))
    log.append('activate', { id: 'abcd1234', mismatch: false })
    log.append('repaint')
    log.flushSync()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({
      t: '2026-10-24T08:00:00.000Z',
      ev: 'activate',
      id: 'abcd1234',
      mismatch: false
    })
    expect(JSON.parse(lines[1]!).ev).toBe('repaint')
  })

  it('append 는 파일에 바로 쓰지 않고(메인 스레드를 막지 않음) 잠시 뒤 비동기로 쓴다', async () => {
    vi.useFakeTimers()
    const file = join(tmp(), 'paint-diag.log')
    const log = new PaintDiagLog(file)
    log.append('a')
    log.append('b')
    expect(existsSync(file)).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    vi.useRealTimers()
    // 비동기 appendFile 이 끝나기를 기다린다
    for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20))
    for (let i = 0; i < 50 && readFileSync(file, 'utf8').trim().split('\n').length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).ev)).toEqual(['a', 'b'])
  })

  it('용량이 한도를 넘으면 .1 로 밀고 새 파일에 이어 쓴다', () => {
    const file = join(tmp(), 'paint-diag.log')
    const log = new PaintDiagLog(file, 300)
    for (let i = 0; i < 12; i++) {
      log.append('ev', { i, pad: 'x'.repeat(30) })
      log.flushSync()
    }
    expect(existsSync(`${file}.1`)).toBe(true)
    const cur = readFileSync(file, 'utf8').trim().split('\n')
    const old = readFileSync(`${file}.1`, 'utf8').trim().split('\n')
    expect(cur.length + old.length).toBeLessThanOrEqual(12)
    expect(JSON.parse(cur.at(-1)!).i).toBe(11)
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(300)
  })

  it('한 번에 한도보다 많이 쌓이면 가장 최근 줄만 남긴다', () => {
    const file = join(tmp(), 'paint-diag.log')
    const log = new PaintDiagLog(file, 300)
    for (let i = 0; i < 12; i++) log.append('ev', { i, pad: 'x'.repeat(30) })
    log.flushSync()
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(300)
    expect(JSON.parse(lines.at(-1)!).i).toBe(11)
    expect(lines.length).toBeLessThan(12)
  })

  it('비동기 쓰기가 진행 중일 때의 flushSync 는 파일을 밀지 않는다(진행 중인 쓰기가 새 파일로 들어가는 경합 방지)', () => {
    const file = join(tmp(), 'paint-diag.log')
    const log = new PaintDiagLog(file, 300)
    log.append('first', { pad: 'x'.repeat(60) })
    log.flushSync() // 평소: 파일 약 120바이트
    ;(log as unknown as { writing: boolean }).writing = true // 비동기 appendFile 진행 중인 상태
    log.append('second', { pad: 'y'.repeat(60) })
    log.append('third', { pad: 'z'.repeat(60) }) // 합치면 한도(300)를 넘는다 — 평소라면 옛 파일을 민다
    log.flushSync()
    expect(existsSync(`${file}.1`)).toBe(false)
    const evs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).ev)
    expect(evs).toEqual(['first', 'second', 'third'])
  })

  it('이미 있는 파일 크기를 이어받아 한도를 센다', () => {
    const file = join(tmp(), 'paint-diag.log')
    writeFileSync(file, 'x'.repeat(290))
    const log = new PaintDiagLog(file, 300)
    log.append('ev', { a: 1 })
    log.flushSync()
    expect(existsSync(`${file}.1`)).toBe(true)
  })

  it('쓸 수 없는 경로여도 예외를 던지지 않는다', () => {
    const dir = tmp()
    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'x')
    const log = new PaintDiagLog(join(blocker, 'sub', 'paint-diag.log'))
    expect(() => {
      log.append('ev')
      log.flushSync()
    }).not.toThrow()
  })
})

describe('shortId', () => {
  it('앞 8자만, 없으면 -', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567')
    expect(shortId(null)).toBe('-')
    expect(shortId(undefined)).toBe('-')
  })
})
