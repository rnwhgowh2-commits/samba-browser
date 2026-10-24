import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { WebContents } from 'electron'
import { ensureDebuggerAttached, keepDebuggerAttached } from '../browser/emulation'
import { formatRow, NetworkRecorder, type CdpLike } from '../browser/network-recorder'
import { clip, isSensitiveEndpoint } from '../../shared/network-redact'
// 순환 import 를 피하려고 타입만 가져온다(런타임 코드는 남지 않는다)
import type { ToolContext } from './tools'
import { secretKeypadGate, isPinAuthUrl } from './secret-page'
import { agentTargetOf } from './target'

// 네트워크 기록 도구 — 개발자도구 Network 패널 대신 "이 화면이 어떤 요청을 어떤 조건으로 불렀나"를 읽는다.
// 조회 전용이다(페이지를 조작하지 않고 요청을 막지도 바꾸지도 않는다). 그래서 read_only 모드에서도 허용한다.
// 비밀값(쿠키·토큰·비밀번호 필드)은 기록 단계에서 가려지고, 로그인·결제 계열 주소의 본문은 싣지 않는다.

const NO_TAB = 'no active tab'
const SECRET_SCREEN = 'refused: secret screen'
// 결과 한 번의 글자 수 상한 — 컨텍스트를 잡아먹지 않게 한다
const MAX_LIST_CHARS = 14_000
const DEFAULT_GET_CHARS = 6_000
const MAX_GET_CHARS = 30_000
// 켜 둔 기록이 잊혀 계속 돌지 않게 하는 자동 종료(마지막 사용 이후)
const IDLE_STOP_MS = 30 * 60 * 1000

const registry = new WeakMap<
  WebContents,
  { rec: NetworkRecorder; lastUsed: number; timer: NodeJS.Timeout | null }
>()

function textResult(t: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: t }] }
}

export type NetworkSlot = { rec: NetworkRecorder; lastUsed: number; timer: NodeJS.Timeout | null }

/** 이 탭의 기록 슬롯(없으면 만든다). 디버거는 호출부가 먼저 붙여 둔다 */
export function ensureNetworkSlot(wc: WebContents): NetworkSlot {
  let slot = registry.get(wc)
  if (!slot) {
    slot = {
      rec: new NetworkRecorder(wc.debugger as unknown as CdpLike, {
        omitBodies: (url, doc, method) =>
          isPinAuthUrl(url) || isPinAuthUrl(doc) || isSensitiveEndpoint(url, method)
      }),
      lastUsed: Date.now(),
      timer: null
    }
    registry.set(wc, slot)
  }
  return slot
}

export function armNetworkIdleStop(wc: WebContents): void {
  armIdleStop(wc)
}

export function slotFor(
  wc: WebContents
): { rec: NetworkRecorder; lastUsed: number; timer: NodeJS.Timeout | null } | undefined {
  return registry.get(wc)
}

function armIdleStop(wc: WebContents): void {
  const slot = registry.get(wc)
  if (!slot) return
  slot.lastUsed = Date.now()
  if (slot.timer) clearTimeout(slot.timer)
  slot.timer = setTimeout(() => {
    void slot.rec.stop('idle 30 min').catch(() => undefined)
  }, IDLE_STOP_MS)
  slot.timer.unref?.()
}

const recordSchema = {
  action: z.enum(['start', 'stop', 'clear', 'status']),
  url_filter: z.string().optional()
}
const listSchema = {
  filter: z.string().optional(),
  types: z.string().optional(),
  method: z.string().optional(),
  min_status: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional()
}
const getSchema = {
  index: z.number(),
  part: z.enum(['all', 'request', 'response']).optional(),
  max_chars: z.number().optional()
}

// 도구마다 입력 스키마 타입이 달라 하나의 배열 타입으로 못 묶는다 — tools.ts 의 목록이 받는 모양으로 한 번만 맞춘다
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = SdkMcpToolDefinition<any>

/**
 * 네트워크 기록 도구 3개. 작업 대상(활성 탭 또는 고른 팝업)의 요청을 기록한다.
 *  - network_record: 시작·중지·비우기·상태
 *  - network_list: 기록 목록(필터)
 *  - network_get: 요청 하나의 헤더·본문·호출 위치
 */
export function createNetworkTools(ctx: ToolContext): AnyTool[] {
  const targetWc = (): { wc: WebContents; url: string } | string => {
    const tab = agentTargetOf(ctx.tabs)
    if (!tab) return NO_TAB
    const wc = tab.view.webContents
    return { wc, url: wc.getURL() }
  }

  const gate = async (): Promise<string | null> => {
    const tab = agentTargetOf(ctx.tabs)
    if (!tab) return NO_TAB
    if (isPinAuthUrl(tab.view.webContents.getURL())) return SECRET_SCREEN
    if (await secretKeypadGate.check(tab).catch(() => false)) return SECRET_SCREEN
    return null
  }

  const record = tool(
    'network_record',
    'Record the network requests (XHR/fetch/document and more) of the active tab, like the browser devtools Network panel. ' +
      'action "start" begins recording (optionally url_filter: only URLs containing this text); then use the page normally ' +
      '(open it, click, change options, go to page 2) and read the result with network_list / network_get. ' +
      '"stop" ends it (entries stay readable), "clear" empties the list, "status" shows counts. ' +
      'Requests made before "start" are NOT recorded - start first, then reload or act. ' +
      'Cookie/authorization/token values are masked and login/payment request bodies are omitted.',
    recordSchema,
    async ({ action, url_filter }) => {
      const over = ctx.tick()
      if (over) return textResult(over)
      const t = targetWc()
      if (typeof t === 'string') return textResult(t)
      const { wc } = t
      try {
        if (action === 'status') {
          const slot = slotFor(wc)
          if (!slot) return textResult('not recording (no network_record start on this tab yet)')
          return textResult(JSON.stringify(slot.rec.status()))
        }
        if (action === 'clear') {
          const slot = slotFor(wc)
          if (!slot) return textResult('nothing to clear')
          slot.rec.clear()
          return textResult('ok: cleared')
        }
        if (action === 'stop') {
          const slot = slotFor(wc)
          if (!slot) return textResult('not recording')
          if (slot.timer) clearTimeout(slot.timer)
          await slot.rec.stop('stopped')
          return textResult(`ok: stopped. ${JSON.stringify(slot.rec.status())}`)
        }
        // start
        const blocked = await gate()
        if (blocked) return textResult(blocked)
        if (!ensureDebuggerAttached(wc))
          return textResult('error: could not attach the debugger to this tab')
        keepDebuggerAttached(wc)
        const slot = ensureNetworkSlot(wc)
        await slot.rec.start(url_filter ?? '', true)
        armIdleStop(wc)
        ctx.onStep('네트워크 기록 시작', true)
        return textResult(
          `ok: recording ${wc.getURL().slice(0, 120)}${url_filter ? ` (only urls containing "${url_filter}")` : ''}. ` +
            'Now reload or act on the page, then call network_list.'
        )
      } catch (e) {
        ctx.onStep('네트워크 기록', false)
        return textResult(`error: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  )

  const list = tool(
    'network_list',
    'List the requests recorded by network_record on the active tab: "#index METHOD status type mime ms url". ' +
      'Default shows xhr/fetch/document/other only; pass types="all" or e.g. "xhr,fetch,script" to change. ' +
      'filter = text the URL must contain; method = GET/POST...; min_status = e.g. 400 for errors; limit (max 200) / offset page through. ' +
      'Then read one request in full with network_get.',
    listSchema,
    async ({ filter, types, method, min_status, limit, offset }) => {
      const over = ctx.tick()
      if (over) return textResult(over)
      const t = targetWc()
      if (typeof t === 'string') return textResult(t)
      const slot = slotFor(t.wc)
      if (!slot) return textResult('no recording on this tab: call network_record start first')
      const blocked = await gate()
      if (blocked) return textResult(blocked)
      armIdleStop(t.wc)
      await slot.rec.settle(2000)
      const { rows, total } = slot.rec.list({
        filter,
        types: types
          ? types
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        method,
        minStatus: min_status,
        limit,
        offset
      })
      const st = slot.rec.status()
      const head = `recording=${st.active}${st.stopReason ? ` (${st.stopReason})` : ''} matched=${total} shown=${rows.length}${total > rows.length + (offset ?? 0) ? ' (use offset for more)' : ''}`
      if (rows.length === 0) return textResult(`${head}\n(no matching requests)`)
      return textResult(clip(`${head}\n${rows.map(formatRow).join('\n')}`, MAX_LIST_CHARS))
    }
  )

  const get = tool(
    'network_get',
    'Show one recorded request in full: request headers (cookie/authorization masked) and body, response status/headers/body, ' +
      'and where in the page code it was called from (initiator). index = the #number from network_list. ' +
      'part = "request" | "response" | "all" (default); max_chars limits the output (default 6000).',
    getSchema,
    async ({ index, part, max_chars }) => {
      const over = ctx.tick()
      if (over) return textResult(over)
      const t = targetWc()
      if (typeof t === 'string') return textResult(t)
      const slot = slotFor(t.wc)
      if (!slot) return textResult('no recording on this tab: call network_record start first')
      const blocked = await gate()
      if (blocked) return textResult(blocked)
      armIdleStop(t.wc)
      await slot.rec.settle(2000)
      const e = slot.rec.get(index)
      if (!e) return textResult(`not found: no recorded request #${index}`)
      const wantReq = part !== 'response'
      const wantRes = part !== 'request'
      const out: Record<string, unknown> = {
        index: e.index,
        method: e.method,
        url: e.url,
        type: e.resourceType,
        at: e.at,
        status: e.status,
        mime: e.mime,
        durationMs: e.durationMs,
        fromCache: e.fromCache,
        protocol: e.protocol,
        initiator: e.initiator,
        page: e.documentUrl,
        ...(e.redirectTo ? { redirectTo: e.redirectTo } : {}),
        ...(e.failed ? { failed: e.failed } : {}),
        ...(e.sensitive ? { note: 'sensitive endpoint: bodies omitted' } : {}),
        ...(e.intercepted
          ? { intercepted: 'blocked by network_guard - NOT sent to the server' }
          : {})
      }
      if (wantReq)
        out.request = {
          headers: e.reqHeaders,
          body: e.reqBody,
          bodyBytes: Math.max(0, e.reqBodyBytes)
        }
      if (wantRes)
        out.response = {
          headers: e.resHeaders,
          body: e.resBody,
          bodyBytes: e.resBodyBytes,
          ...(e.resBodyNote ? { note: e.resBodyNote } : {})
        }
      const limitChars = Math.min(MAX_GET_CHARS, Math.max(500, max_chars ?? DEFAULT_GET_CHARS))
      return textResult(clip(JSON.stringify(out, null, 1), limitChars))
    }
  )

  return [record, list, get] as unknown as AnyTool[]
}

export const NETWORK_TOOL_NAMES = ['network_record', 'network_list', 'network_get'] as const
