import { clip, redactBody } from '../../shared/network-redact'
import type { CdpLike } from './network-recorder'

// 탭의 콘솔 메시지·예외·브라우저 로그(Failed to load resource 등)를 CDP 로 기록한다.
// 개발자도구 Console 패널 대신 읽는 입구이며 읽기 전용이다. 글자 속 비밀값(token="…", ?password=…)은 가린다.

export interface ConsoleEntry {
  index: number
  at: string
  level: string
  source: 'console' | 'exception' | 'log'
  text: string
  where: string
}

export interface ConsoleListQuery {
  level?: string
  filter?: string
  limit?: number
  offset?: number
}

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function argText(a: P): string {
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
  return String(a.description ?? a.type ?? '')
}

export class ConsoleRecorder {
  private entries: ConsoleEntry[] = []
  private next = 1
  private active = false
  private stopReason: string | null = null
  private onMessage: ((e: unknown, method: string, params: P) => void) | null = null
  private onDetach: ((e: unknown, reason: string) => void) | null = null

  constructor(
    private readonly dbg: CdpLike,
    private readonly maxEntries = 500
  ) {}

  get isActive(): boolean {
    return this.active
  }

  status(): { active: boolean; count: number; stopReason: string | null } {
    return { active: this.active, count: this.entries.length, stopReason: this.stopReason }
  }

  async start(clearFirst = true): Promise<void> {
    if (clearFirst) this.clear()
    if (this.active) return
    this.onMessage = (_e, method, params) => this.handle(method, params ?? {})
    this.onDetach = (_e, reason) => {
      this.active = false
      this.stopReason = `debugger detached: ${reason}`
      this.detach()
    }
    this.dbg.on('message', this.onMessage)
    this.dbg.on('detach', this.onDetach)
    try {
      await this.dbg.sendCommand('Runtime.enable')
      await this.dbg.sendCommand('Log.enable')
      this.active = true
      this.stopReason = null
    } catch (e) {
      this.detach()
      throw e
    }
  }

  async stop(reason = 'stopped'): Promise<void> {
    if (this.active) {
      this.active = false
      this.stopReason = reason
      await this.dbg.sendCommand('Log.disable').catch(() => undefined)
      await this.dbg.sendCommand('Runtime.disable').catch(() => undefined)
    }
    this.detach()
  }

  clear(): void {
    this.entries = []
    this.next = 1
  }

  list(q: ConsoleListQuery = {}): { rows: ConsoleEntry[]; total: number } {
    const level = q.level?.toLowerCase()
    const filter = q.filter?.toLowerCase()
    const matched = this.entries.filter((e) => {
      if (level && level !== 'all') {
        if (level === 'error' ? e.level !== 'error' : e.level !== level) return false
      }
      if (filter && !e.text.toLowerCase().includes(filter)) return false
      return true
    })
    const offset = Math.max(0, q.offset ?? 0)
    const limit = Math.min(200, Math.max(1, q.limit ?? 80))
    return { rows: matched.slice(offset, offset + limit), total: matched.length }
  }

  private add(
    level: string,
    source: ConsoleEntry['source'],
    text: string,
    where: string,
    ts?: number
  ): void {
    const at = new Date(ts && ts > 1e12 ? ts : Date.now()).toISOString()
    this.entries.push({
      index: this.next++,
      at,
      level,
      source,
      text: clip(redactBody(text, 'text/plain'), 1200),
      where
    })
    while (this.entries.length > this.maxEntries) this.entries.shift()
  }

  private handle(method: string, p: P): void {
    if (!this.active) return
    try {
      if (method === 'Runtime.consoleAPICalled') {
        const type = String(p.type ?? 'log')
        const level = type === 'warning' ? 'warn' : type
        const text = ((p.args as P[] | undefined) ?? []).map(argText).join(' ')
        const top = p.stackTrace?.callFrames?.[0] as P | undefined
        this.add(
          level,
          'console',
          text,
          top?.url ? `${top.url}:${Number(top.lineNumber ?? 0) + 1}` : '',
          Number(p.timestamp)
        )
      } else if (method === 'Runtime.exceptionThrown') {
        const d = (p.exceptionDetails ?? {}) as P
        const text = String(d.exception?.description ?? d.text ?? 'exception')
        this.add(
          'error',
          'exception',
          text,
          d.url ? `${d.url}:${Number(d.lineNumber ?? 0) + 1}` : '',
          Number(p.timestamp)
        )
      } else if (method === 'Log.entryAdded') {
        const e = (p.entry ?? {}) as P
        const level = String(e.level ?? 'info') === 'warning' ? 'warn' : String(e.level ?? 'info')
        this.add(
          level,
          'log',
          `[${e.source ?? 'log'}] ${e.text ?? ''}`,
          e.url ? `${e.url}:${Number(e.lineNumber ?? 0) + 1}` : '',
          Number(e.timestamp)
        )
      }
    } catch (e) {
      console.error('콘솔 기록 처리 실패', e instanceof Error ? e.message : String(e))
    }
  }

  private detach(): void {
    if (this.onMessage) this.dbg.removeListener('message', this.onMessage)
    if (this.onDetach) this.dbg.removeListener('detach', this.onDetach)
    this.onMessage = null
    this.onDetach = null
  }
}

export function formatConsoleRow(e: ConsoleEntry): string {
  return `#${e.index} ${e.level} ${e.source} ${clip(e.text.replace(/\s+/g, ' '), 300)}${e.where ? ` @ ${clip(e.where, 120)}` : ''}`
}
