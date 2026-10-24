// 탭 화면이 흰 채로 안 그려지는 문제의 진단 기록과 복구 판정(2026-10-24).
//
// 실기: 탭 DOM 은 정상이고 렌더러는 프레임을 만드는데 창에는 흰 화면만 보이고, 그 탭의 capturePage 가
// 90초 넘게 돌아오지 않았다. 앱이 다시 켜지면 현장이 사라져 원인을 못 찾았다 — 그래서 탭 층(z-order)·
// 프로세스 이상·캡처 지연을 파일에 남기고(userData/logs/paint-diag.log), 층이 어긋난 상태는 스스로 바로잡는다.
// Electron 없이 시험할 수 있게 순수 함수·파일 쓰기만 둔다.
import { appendFile, appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** 로그 한 줄에 쓰는 탭 id 는 앞 8자만 — 긴 UUID 를 줄 때마다 적지 않는다 */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '-'
}

/**
 * contentView 의 자식 순서(아래 → 위)에서 맨 위 탭 id. 탭이 아닌 뷰(확장 팝업 등)는 null 로 들어오며 건너뛴다.
 * 탭이 하나도 없으면 null
 */
export function topTabId(order: ReadonlyArray<string | null>): string | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    if (id !== null) return id
  }
  return null
}

/**
 * 보이는 탭(activeId)이 탭 중 맨 위가 아니면 층이 어긋난 것이다 — 다른 탭이 위에서 가린다.
 * 보이는 탭이 없으면(설정 화면 등) 어긋난 것으로 보지 않는다
 */
export function stackMismatch(order: ReadonlyArray<string | null>, activeId: string | null): boolean {
  if (activeId === null) return false
  const top = topTabId(order)
  return top !== null && top !== activeId
}

/** before-input-event 가 주는 값 중 판정에 필요한 부분만 */
export interface RepaintKeyInput {
  type: string
  key: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  /** 물리 키 위치(KeyboardEvent.code). 한글 입력기가 켜져 있으면 key 가 'ㄱ'·'Process' 로 오므로 이쪽을 먼저 본다 */
  code?: string
}

/**
 * 화면 다시 그리기 단축키 Ctrl(또는 Cmd)+Alt+R. 확대·축소(Alt 없음)·캡처(Alt+숫자)·작업공간(Ctrl+Alt+숫자)과 겹치지 않는다.
 * 한글 자판·한글 입력 상태에서도 같은 물리 키(KeyR)면 받는다. 물리 키(code)가 오면 그것만 보고(다른 키가 'r' 로
 * 재매핑돼 와도 가로채지 않는다), 없을 때만 key 로 판정한다
 */
export function isRepaintShortcut(input: RepaintKeyInput): boolean {
  if (input.type !== 'keyDown') return false
  if (!(input.control || input.meta) || !input.alt || input.shift) return false
  if (typeof input.code === 'string' && input.code !== '') return input.code === 'KeyR'
  return input.key.toLowerCase() === 'r'
}

/**
 * 자동 복구 횟수 제한 — 복구가 계속 실패하는 상태에서 층을 무한히 다시 쌓지 않게 한다.
 * 마지막 복구 후 cooldownMs 가 지나야 다시 허용하고, windowMs 안에 maxPerWindow 번까지만 허용한다
 */
export class HealGate {
  private stamps: number[] = []
  constructor(
    private readonly cooldownMs = 30_000,
    private readonly windowMs = 10 * 60_000,
    private readonly maxPerWindow = 5
  ) {}

  allow(now: number): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs)
    const last = this.stamps[this.stamps.length - 1]
    if (last !== undefined && now - last < this.cooldownMs) return false
    if (this.stamps.length >= this.maxPerWindow) return false
    this.stamps.push(now)
    return true
  }
}

export const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024

/** 모아 둔 줄을 파일로 내보내기까지 기다리는 시간 */
const FLUSH_DELAY_MS = 250
/** 쓰기가 밀려도 메모리가 늘지 않게 모아 두는 줄 수 상한(넘으면 옛 줄부터 버린다) */
const MAX_PENDING_LINES = 2000

/**
 * 한 줄 JSON 로그. 용량이 maxBytes 를 넘으면 `.1` 로 한 번 밀고 새로 쓴다(최대 약 2×maxBytes).
 * 줄은 메모리에 모았다가 비동기로 쓴다 — 탭 전환(activate)마다 부르므로 메인 스레드에서 디스크를 기다리지 않는다.
 * 종료 직전에는 flushSync 로 남은 줄을 비운다. 기록이 앱 동작을 막으면 안 되므로 어떤 쓰기 오류도 삼킨다
 */
export class PaintDiagLog {
  private size = -1
  private pending: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing = false

  constructor(
    private readonly file: string,
    private readonly maxBytes = DEFAULT_MAX_LOG_BYTES,
    private readonly now: () => number = Date.now
  ) {}

  append(ev: string, data?: Record<string, unknown>): void {
    try {
      this.pending.push(`${JSON.stringify({ t: new Date(this.now()).toISOString(), ev, ...data })}\n`)
      if (this.pending.length > MAX_PENDING_LINES) this.pending.shift()
      this.schedule()
    } catch {
      // 진단 기록 실패는 무시한다
    }
  }

  /** 모아 둔 줄을 지금 동기로 파일에 쓴다 — 앱 종료 직전·시험용 */
  flushSync(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    // 비동기 쓰기가 진행 중이면 그 파일을 옛 파일로 밀지 않는다(밀면 진행 중인 쓰기가 새 파일로 들어가 순서·크기가 어긋난다).
    // 종료 직전이라 한도를 조금 넘는 것은 다음 시작 때 바로잡힌다
    const chunk = this.take(!this.writing)
    if (chunk === null) return
    try {
      appendFileSync(this.file, chunk, 'utf8')
    } catch {
      // 무시
    }
  }

  private schedule(): void {
    if (this.timer !== null || this.writing) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_DELAY_MS)
    this.timer.unref()
  }

  /** 모아 둔 줄을 비동기로 쓴다(한 번에 하나만 — 쓰는 동안 쌓인 줄은 끝난 뒤 다음 차례) */
  private flush(): void {
    const chunk = this.take()
    if (chunk === null) return
    this.writing = true
    appendFile(this.file, chunk, 'utf8', () => {
      this.writing = false
      if (this.pending.length > 0) this.schedule()
    })
  }

  /** 쓸 줄을 꺼내 크기를 맞춘다. 한도를 넘으면 옛 파일을 밀고, 한 번에 한도보다 많이 쌓였으면 최근 줄만 남긴다 */
  private take(allowRotate = true): string | null {
    if (this.pending.length === 0) return null
    const lines = this.pending
    this.pending = []
    try {
      this.ensureReady()
      let kept = 0
      let bytes = 0
      for (let i = lines.length - 1; i >= 0; i--) {
        if (bytes + lines[i]!.length > this.maxBytes) break
        bytes += lines[i]!.length
        kept++
      }
      if (kept === 0) return null
      if (allowRotate && this.size + bytes > this.maxBytes) this.rotate()
      this.size += bytes
      return lines.slice(lines.length - kept).join('')
    } catch {
      return null
    }
  }

  private ensureReady(): void {
    if (this.size >= 0) return
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.size = existsSync(this.file) ? statSync(this.file).size : 0
  }

  private rotate(): void {
    try {
      renameSync(this.file, `${this.file}.1`)
    } catch {
      // 옛 파일을 못 밀어도 새로 이어 쓴다
    }
    this.size = 0
  }
}

/** withCaptureTimeout 이 시간 안에 못 받았을 때 돌려주는 표식 */
export const CAPTURE_TIMEOUT = Symbol('capture-timeout')

/**
 * capturePage 처럼 화면이 안 그려지면 영영 돌아오지 않는 호출에 시간 제한을 건다.
 * 시간이 지나면 CAPTURE_TIMEOUT 을 돌려주고, 늦게 끝난 결과·오류는 조용히 버린다
 */
export async function withCaptureTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T | typeof CAPTURE_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof CAPTURE_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CAPTURE_TIMEOUT), ms)
  })
  promise.catch(() => {})
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

let shared: PaintDiagLog | null = null

/** 앱 전체가 같이 쓰는 로그(경로는 시작할 때 한 번 정한다). 정하기 전에는 기록하지 않는다 */
export function initPaintDiag(file: string): PaintDiagLog {
  shared = new PaintDiagLog(file)
  return shared
}

export function paintDiag(ev: string, data?: Record<string, unknown>): void {
  shared?.append(ev, data)
}

/** 앱 종료 직전에 모아 둔 줄을 파일에 남긴다 */
export function flushPaintDiag(): void {
  shared?.flushSync()
}
