import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { WebContents } from 'electron'
import { ensureDebuggerAttached, keepDebuggerAttached } from '../browser/emulation'
import { ConsoleRecorder, formatConsoleRow } from '../browser/console-recorder'
import { NetworkGuard } from '../browser/network-guard'
import type { CdpLike } from '../browser/network-recorder'
import { clip, redactBody } from '../../shared/network-redact'
import { isDangerous } from '../../shared/danger'
import type { ToolContext } from './tools'
import { armNetworkIdleStop, ensureNetworkSlot } from './tools-network'
import { isPinAuthUrl, secretKeypadGate } from './secret-page'
import { agentTargetOf } from './target'

// 페이지 도구 3개 — 옛 Aside REPL 이 하던 일을 삼바 브라우저에서 하게 한다.
//  - page_eval: 페이지 안에서 JS 실행(그 페이지의 로그인·쿠키로 fetch 가능). 쿠키·저장소·비밀번호 칸 읽기는 거절하고 결과의 비밀값은 가린다
//  - console_read: 콘솔 메시지·예외·브라우저 로그
//  - network_guard: 데이터를 바꾸는 요청(POST 등)을 서버로 보내지 않고 막아 본문만 network_record 에 남긴다

const NO_TAB = 'no active tab'
const SECRET_SCREEN = 'refused: secret screen'
const READ_ONLY_REFUSAL = 'refused: read-only mode'
const MAX_CODE = 6000
const EVAL_TIMEOUT_MS = 20_000
const MAX_RESULT_CHARS = 8000
const IDLE_MS = 10 * 60 * 1000

// 쿠키·저장소·비밀번호 칸을 읽는 코드는 실행하지 않는다 (AI 가 비밀값을 보지 못한다는 앱의 원칙)
const FORBIDDEN_CODE: Array<[RegExp, string]> = [
  [/document\s*\.\s*cookie|cookieStore|\bgetCookie\b/i, 'cookies'],
  [/\b(local|session)Storage\b|\bindexedDB\b/i, 'web storage'],
  [
    /type\s*=\s*["']?password|\[type=password\]|input\[type\s*=\s*["']?password/i,
    'password fields'
  ],
  [/Authorization|x-auth/i, 'auth headers']
]

function textResult(t: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: t }] }
}

const consoleRegistry = new WeakMap<
  WebContents,
  { rec: ConsoleRecorder; timer: NodeJS.Timeout | null }
>()
const guardRegistry = new WeakMap<
  WebContents,
  { guard: NetworkGuard; timer: NodeJS.Timeout | null }
>()

const evalSchema = { code: z.string() }
const consoleSchema = {
  action: z.enum(['start', 'stop', 'clear', 'read']).optional(),
  level: z.string().optional(),
  filter: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional()
}
const guardSchema = {
  action: z.enum(['on', 'off', 'status']),
  allow: z.string().optional()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = SdkMcpToolDefinition<any>

/** 입력 코드가 거절 대상인지 — 이유 문자열 또는 null */
export function forbiddenCodeReason(code: string): string | null {
  for (const [re, why] of FORBIDDEN_CODE) if (re.test(code)) return why
  return null
}

/** 실행 결과(값)를 글자로 만들고 비밀 이름의 값은 가린다 */
export function formatEvalValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  let s: string
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    s = String(value)
  }
  if (s === undefined) return 'undefined'
  return clip(
    redactBody(s, typeof value === 'string' ? 'text/plain' : 'application/json'),
    MAX_RESULT_CHARS
  )
}

export function createPageTools(ctx: ToolContext): AnyTool[] {
  const target = async (): Promise<{ wc: WebContents } | string> => {
    const tab = agentTargetOf(ctx.tabs)
    if (!tab) return NO_TAB
    const wc = tab.view.webContents
    if (isPinAuthUrl(wc.getURL())) return SECRET_SCREEN
    if (await secretKeypadGate.check(tab).catch(() => false)) return SECRET_SCREEN
    return { wc }
  }

  const pageEval = tool(
    'page_eval',
    'Run JavaScript inside the active page (like the devtools console) and return the result as JSON text. ' +
      'The code is the BODY of an async function: use `return` to give a value, and `await` freely, e.g. ' +
      '`const r = await fetch("/api/goods/1"); return await r.json();` - fetch uses the page own login session. ' +
      'Also good for reading the DOM: `return document.title`. Results are masked for secret-looking keys, truncated to 8000 chars, ' +
      'and 20s max. Reading cookies, web storage, password fields or Authorization headers is refused. ' +
      'Not allowed in read-only mode. Do NOT send POST/PUT/DELETE requests unless the user asked for that change.',
    evalSchema,
    async ({ code }) => {
      const over = ctx.tick()
      if (over) return textResult(over)
      if (ctx.mode === 'read_only') return textResult(READ_ONLY_REFUSAL)
      if (code.length > MAX_CODE) return textResult(`refused: code longer than ${MAX_CODE} chars`)
      const why = forbiddenCodeReason(code)
      if (why) return textResult(`refused: code touches ${why}`)
      const t = await target()
      if (typeof t === 'string') return textResult(t)
      if (ctx.mode !== 'full' && isDangerous(code, ctx.dangerWords)) {
        const ok = await ctx.confirm(`JS 실행: ${code.slice(0, 120)}`, 'danger')
        if (!ok) return textResult('denied by user')
      }
      const { wc } = t
      try {
        if (!ensureDebuggerAttached(wc))
          return textResult('error: could not attach the debugger to this tab')
        keepDebuggerAttached(wc)
        const res = (await wc.debugger.sendCommand('Runtime.evaluate', {
          expression: `(async () => {\n${code}\n})()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: EVAL_TIMEOUT_MS,
          userGesture: false
        })) as {
          result?: { value?: unknown; type?: string; description?: string }
          exceptionDetails?: { text?: string; exception?: { description?: string } }
        }
        if (res.exceptionDetails) {
          ctx.onStep('JS 실행', false)
          const d = res.exceptionDetails
          return textResult(
            `error: ${clip(String(d.exception?.description ?? d.text ?? 'exception'), 1500)}`
          )
        }
        ctx.onStep('JS 실행', true)
        const r = res.result
        if (r && r.value === undefined && r.description)
          return textResult(`(${r.type}) ${r.description}`)
        return textResult(formatEvalValue(r?.value))
      } catch (e) {
        ctx.onStep('JS 실행', false)
        return textResult(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  const consoleRead = tool(
    'console_read',
    'Read the console of the active tab: console.log/warn/error calls, uncaught exceptions and browser log lines ' +
      '(e.g. "Failed to load resource: 404"). action "start" begins recording (only messages after start are kept - then reload or act), ' +
      '"read" (default) lists them, "clear" empties, "stop" ends. level = error | warn | info | log | all; filter = text; limit/offset page through. ' +
      'Secret-looking values are masked.',
    consoleSchema,
    async ({ action, level, filter, limit, offset }) => {
      const over = ctx.tick()
      if (over) return textResult(over)
      const t = await target()
      if (typeof t === 'string') return textResult(t)
      const { wc } = t
      const act = action ?? 'read'
      try {
        let slot = consoleRegistry.get(wc)
        if (act === 'start') {
          if (!ensureDebuggerAttached(wc))
            return textResult('error: could not attach the debugger to this tab')
          keepDebuggerAttached(wc)
          if (!slot) {
            slot = { rec: new ConsoleRecorder(wc.debugger as unknown as CdpLike), timer: null }
            consoleRegistry.set(wc, slot)
          }
          await slot.rec.start(true)
          if (slot.timer) clearTimeout(slot.timer)
          const s = slot
          s.timer = setTimeout(() => void s.rec.stop('idle').catch(() => undefined), 30 * 60 * 1000)
          s.timer.unref?.()
          return textResult(
            'ok: console recording started. Reload or act on the page, then call console_read.'
          )
        }
        if (!slot)
          return textResult(
            'no console recording on this tab: call console_read with action "start" first'
          )
        if (act === 'stop') {
          if (slot.timer) clearTimeout(slot.timer)
          await slot.rec.stop('stopped')
          return textResult(`ok: stopped. ${JSON.stringify(slot.rec.status())}`)
        }
        if (act === 'clear') {
          slot.rec.clear()
          return textResult('ok: cleared')
        }
        const { rows, total } = slot.rec.list({ level, filter, limit, offset })
        const st = slot.rec.status()
        const head = `recording=${st.active}${st.stopReason ? ` (${st.stopReason})` : ''} matched=${total} shown=${rows.length}`
        if (rows.length === 0) return textResult(`${head}\n(no messages)`)
        return textResult(clip(`${head}\n${rows.map(formatConsoleRow).join('\n')}`, 14_000))
      } catch (e) {
        return textResult(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  const guardTool = tool(
    'network_guard',
    'Safety guard for observing what a button WOULD send: while "on", requests that change data (anything except GET/HEAD/OPTIONS, ' +
      'e.g. POST from a "create group" button) are NOT sent to the server - the page just gets a fake 200 {"intercepted":true}. ' +
      'Their URL and body stay readable with network_list / network_get (marked INTERCEPTED). Network recording is started automatically. ' +
      'allow = comma-separated URL texts that may still pass through (e.g. read-only POST searches). "off" restores normal behavior, "status" shows the count. ' +
      'Only the main page is guarded (iframes are not). The guard turns itself off after 10 minutes. ' +
      'It does not stop page navigations by GET or form posts you did not intercept - check status before clicking anything that changes data.',
    guardSchema,
    async ({ action, allow }) => {
      const over = ctx.tick()
      if (over) return textResult(over)
      const t = await target()
      if (typeof t === 'string') return textResult(t)
      const { wc } = t
      try {
        const slot = guardRegistry.get(wc)
        if (action === 'status') {
          return textResult(slot ? JSON.stringify(slot.guard.status()) : 'guard is off')
        }
        if (action === 'off') {
          if (!slot) return textResult('guard is off')
          if (slot.timer) clearTimeout(slot.timer)
          await slot.guard.disable()
          return textResult(
            `ok: guard off. blocked ${slot.guard.status().blocked} request(s) while on`
          )
        }
        if (!ensureDebuggerAttached(wc))
          return textResult('error: could not attach the debugger to this tab')
        keepDebuggerAttached(wc)
        const net = ensureNetworkSlot(wc)
        if (!net.rec.isActive) await net.rec.start('', false)
        armNetworkIdleStop(wc)
        let g = slot
        if (!g) {
          g = {
            guard: new NetworkGuard(wc.debugger as unknown as CdpLike, (id) =>
              net.rec.markIntercepted(id)
            ),
            timer: null
          }
          guardRegistry.set(wc, g)
        }
        await g.guard.enable((allow ?? '').split(',').map((s) => s.trim()))
        if (g.timer) clearTimeout(g.timer)
        const gg = g
        gg.timer = setTimeout(() => void gg.guard.disable().catch(() => undefined), IDLE_MS)
        gg.timer.unref?.()
        ctx.onStep('요청 가로채기 켬', true)
        return textResult(
          'ok: guard ON - data-changing requests are blocked (fake 200) and recorded. Act on the page, then read network_list. ' +
            'Call network_guard off when done.'
        )
      } catch (e) {
        return textResult(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  return [pageEval, consoleRead, guardTool] as unknown as AnyTool[]
}

export const PAGE_TOOL_NAMES = ['page_eval', 'console_read', 'network_guard'] as const
