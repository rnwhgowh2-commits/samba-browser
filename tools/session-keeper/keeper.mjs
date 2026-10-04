#!/usr/bin/env node
// 세션 관리자 — 소싱처별 로그인 상태를 주기적으로 확인하고, 풀렸으면 복구한다.
//
//   node keeper.mjs once  [--site ID] [--dry]   한 번 점검(--dry 이면 복구하지 않는다)
//   node keeper.mjs watch [--interval 분]        계속 돈다(기본 15분 + 흔들림)
//   node keeper.mjs status                       마지막 점검 결과 표
//   node keeper.mjs test-relogin --site ID       (시험용) 로그아웃 → 복구 전략 → 재확인
//
// 원칙
//  - 비밀번호를 입력하지 않는다. 버튼 클릭과 주소 이동만 한다.
//  - 로그인 "판정 불가"일 때는 아무것도 하지 않는다(거짓 복구 방지).
//  - 네이버가 로그아웃이면 네이버 소셜 사이트 복구를 시도하지 않고 '네이버 필요'로 알린다.
//  - 사이트마다 하루 시도 한도·최소 간격·연속 실패 중단을 둔다.
//  - 점검·복구는 레인(lane)으로 돈다 — 사람이 쓰는 탭과 앱 화면(설정 등)에 상관없이 돈다.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { call, health, sleep, BridgeDown, BridgeBusy } from './bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(process.env.APPDATA ?? HERE, 'SAMBA Browser', 'session-keeper')
const STATE_FILE = join(DATA_DIR, 'state.json')
const LOG_FILE = join(DATA_DIR, 'keeper.log')
mkdirSync(DATA_DIR, { recursive: true })

const cfg = JSON.parse(readFileSync(join(HERE, 'sites.json'), 'utf8'))
const DEF = cfg.defaults

const now = () => Date.now()
const stamp = () => new Date().toLocaleString('ko-KR', { hour12: false })
// 콘솔은 사람이 터미널에서 돌릴 때만 쓴다. 숨김 실행(작업 스케줄러)에서는 콘솔이 막혀 있을 수 있어 파일에 먼저 쓰고,
// 콘솔 출력은 실패해도 무시한다(KEEPER_STDOUT=1 이면 파이프에서도 출력)
const TO_CONSOLE = Boolean(process.stdout.isTTY) || Boolean(process.env.KEEPER_STDOUT)
function say(...args) {
  if (!TO_CONSOLE) return
  try {
    console.log(...args)
  } catch {}
}
function log(msg) {
  const line = `[${stamp()}] ${msg}`
  try {
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
  say(line)
}

// --- 상태 파일 --------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { sites: {}, updatedAt: 0 }
  }
}
function saveState(st) {
  st.updatedAt = now()
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8')
}
function siteState(st, id) {
  return (st.sites[id] ??= { status: 'unknown', checkedAt: 0, attempts: [], fails: 0, detail: '' })
}

// --- find_elements 결과 해석 -----------------------------------------------
function parseElements(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\[(\d+)\]\s+(\S+)\s+"(.*?)"(?:\s+href=(\S+))?/.exec(line)
    if (m) out.push({ id: Number(m[1]), role: m[2], name: m[3].trim(), href: m[4] ?? '' })
  }
  return out
}
const nameMatches = (name, marker) =>
  marker.startsWith('~') ? name.includes(marker.slice(1)) : name === marker
const hasMarker = (els, markers = []) => els.some((e) => markers.some((m) => nameMatches(e.name, m)))

// --- 레인 탭 ---------------------------------------------------------------
const laneOf = (site) => `keeper-${site.id}`
const tabIdOf = (r) => r.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]

async function closeLaneTabs(lane) {
  try {
    const tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    for (const t of tabs) await call('close_tab', { id: t.id }, { lane }).catch(() => {})
  } catch {}
}

/** 홈을 레인 탭으로 열어 로그인 표시를 읽는다. in | out | unknown */
async function probeSignedIn(site, { keepTab = false } = {}) {
  const lane = laneOf(site)
  await closeLaneTabs(lane)
  const r = await call('new_tab', { url: site.home, profile: site.profile ?? DEF.profile }, { lane })
  const tabId = tabIdOf(r)
  const deadline = now() + (site.checkTimeoutSec ?? DEF.checkTimeoutSec) * 1000
  let verdict = 'unknown'
  let seen = ''
  try {
    await sleep(3000)
    while (now() < deadline) {
      let els = []
      try {
        // 로그인/로그아웃 요소를 모두 모으려고 흔한 두 글자씩 따로 묻는다(find_elements 는 부분일치)
        const queries = [...new Set([...(site.markers.in ?? []), ...(site.markers.out ?? [])].map((m) => m.replace(/^~/, '')))]
        for (const q of queries) els.push(...parseElements(await call('find_elements', { query: q }, { lane })))
      } catch (e) {
        seen = String(e.message).slice(0, 80)
      }
      if (hasMarker(els, site.markers.in)) {
        verdict = 'in'
        break
      }
      if (hasMarker(els, site.markers.out)) {
        // 로그인 표시만 보이면 한 번 더 확인한다(로딩 중 일시 표시 방지)
        await sleep(2500)
        const again = []
        for (const q of new Set((site.markers.in ?? []).map((m) => m.replace(/^~/, ''))))
          again.push(...parseElements(await call('find_elements', { query: q }, { lane })))
        verdict = hasMarker(again, site.markers.in) ? 'in' : 'out'
        break
      }
      await sleep(2500)
    }
  } finally {
    if (!keepTab && tabId) await call('close_tab', { id: tabId }, { lane }).catch(() => {})
  }
  return { verdict, seen }
}

/** 복구 직후 확인 — 로그인 직후 첫 화면은 느리게 뜨는 경우가 있어 판정 불가면 쉬었다가 몇 번 더 본다 */
async function probeAfterRelogin(site, tries = 3) {
  let p = { verdict: 'unknown', seen: '' }
  for (let i = 0; i < tries; i++) {
    await sleep(i === 0 ? 3000 : 15_000)
    p = await probeSignedIn(site)
    if (p.verdict !== 'unknown') break
  }
  return p
}

// --- 복구 전략 -------------------------------------------------------------
const NAVER_BLOCK_URL = /nid\.naver\.com\/(nidlogin|login|user2|oauth2\.0\/authorize|login\/ext|captcha)/i

/** 레인의 모든 탭 URL 을 읽는다. 네이버 로그인 폼·캡차 화면이면 이유를 돌려준다 */
async function naverBlockReason(lane) {
  try {
    const tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    for (const t of tabs) {
      if (!NAVER_BLOCK_URL.test(t.url || '')) continue
      await call('switch_tab', { id: t.id }, { lane }).catch(() => {})
      const els = parseElements(await call('find_elements', { query: '캡차' }, { lane }).catch(() => ''))
      const pw = parseElements(await call('find_elements', { query: '비밀번호' }, { lane }).catch(() => ''))
      if (els.length) return '네이버 캡차 화면'
      if (pw.length) return '네이버 로그인 폼(세션 없음)'
      return `네이버 인증 화면(${(t.url || '').slice(0, 60)})`
    }
  } catch {}
  return ''
}

async function reloginNaverDirect(site) {
  const lane = laneOf(site)
  await closeLaneTabs(lane)
  await call('new_tab', { url: site.relogin.url, profile: site.profile ?? DEF.profile }, { lane })
  // 성공하면 간편로그인 창이 스스로 닫히거나 성공 주소로 간다. 최대 30초
  const deadline = now() + 30_000
  let reason = ''
  while (now() < deadline) {
    await sleep(2500)
    reason = await naverBlockReason(lane)
    if (reason) break
    let tabs = []
    try {
      tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    } catch {}
    if (tabs.length === 0 || tabs.some((t) => /sns-login-success|\/login\/success/i.test(t.url || ''))) break
  }
  await closeLaneTabs(lane)
  return reason ? { ok: false, reason } : { ok: true }
}

async function reloginNaverClick(site) {
  const lane = laneOf(site)
  await closeLaneTabs(lane)
  const r = await call('new_tab', { url: site.relogin.loginUrl, profile: site.profile ?? DEF.profile }, { lane })
  const tabId = tabIdOf(r)
  await sleep(5000)
  // 이미 로그인돼 로그인 페이지가 홈으로 넘어간 경우
  let els = parseElements(await call('find_elements', { query: site.relogin.text }, { lane }))
  // 버튼·링크를 우선하고, 이름이 짧은(=그 글자뿐인) 요소를 고른다 — 페이지 전체를 감싼 긴 clickable 을 누르지 않게
  const btn = els
    .filter((e) => /네이버|naver/i.test(e.name) && e.name.length <= 20 && /^(button|link|clickable)$/.test(e.role))
    .sort((a, b) => (/^(button|link)$/.test(b.role) ? 1 : 0) - (/^(button|link)$/.test(a.role) ? 1 : 0) || a.name.length - b.name.length)[0]
  if (!btn) {
    await closeLaneTabs(lane)
    return { ok: false, reason: '네이버 로그인 버튼을 찾지 못함' }
  }
  await call('click', { id: btn.id, label: btn.name.slice(0, 20) }, { lane })
  const deadline = now() + 40_000
  let reason = ''
  while (now() < deadline) {
    await sleep(2500)
    reason = await naverBlockReason(lane)
    if (reason) break
    let tabs = []
    try {
      tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    } catch {}
    // 팝업이 닫히고 원래 탭이 로그인 페이지를 벗어났으면 끝난 것으로 본다
    const main = tabs.find((t) => t.id === tabId)
    if (main && !/login/i.test(main.url || '') && tabs.length === 1) break
    if (!main && tabs.length === 0) break
  }
  await closeLaneTabs(lane)
  return reason ? { ok: false, reason } : { ok: true }
}

/** 키마스터에 저장된 계정으로 앱의 login 도구가 입력한다 — 비밀번호는 이 스크립트를 지나지 않는다 */
async function reloginVault(site) {
  const lane = laneOf(site)
  await closeLaneTabs(lane)
  await call('new_tab', { url: site.relogin.loginUrl, profile: site.profile ?? DEF.profile }, { lane })
  await sleep(6000)
  let res = ''
  try {
    res = await call('login', site.relogin.accountLabel ? { accountLabel: site.relogin.accountLabel } : {}, { lane })
  } catch (e) {
    await closeLaneTabs(lane)
    return { ok: false, reason: `login 도구 오류: ${String(e.message).slice(0, 100)}` }
  }
  log(`[${site.id}] login 도구 응답: ${res.replace(/\s+/g, ' ').slice(0, 140)}`)
  const low = res.toLowerCase()
  // 'submitted: check the page for success or captcha/2FA' 는 정상 응답 문구다 — 글자만 보고 캡차로 오판하지 않는다.
  // 제출 응답이 아닌 경우에만 막힘 문구를 찾고, 제출 뒤 실제 결과는 아래 대기와 호출부의 재확인이 가린다
  if (!low.startsWith('submitted') && !low.startsWith('already signed in') && /captcha|캡차|2fa|인증번호|needs_user|handoff|보안문자/.test(low)) {
    await closeLaneTabs(lane)
    return { ok: false, reason: '캡차·추가 인증 필요(사람 개입)' }
  }
  if (/account not found|not set up|locked|잠겨|wrong password|비밀번호가 맞지/.test(low)) {
    await closeLaneTabs(lane)
    return { ok: false, reason: `계정/금고 문제: ${res.replace(/\s+/g, ' ').slice(0, 80)}` }
  }
  // 제출 뒤 로그인 페이지를 벗어날 때까지 최대 30초
  const deadline = now() + 30_000
  while (now() < deadline) {
    await sleep(2500)
    let tabs = []
    try {
      tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    } catch {}
    if (tabs.length && tabs.every((t) => !/login|signin/i.test(t.url || ''))) break
  }
  // 네이버는 로그인 화면에 머물면 캡차·새 기기 인증·보호조치 가능성이 크다 — 더 누르지 않고 사람에게 넘긴다
  if (site.role === 'naver') {
    let stuck = false
    try {
      const tabs = JSON.parse(await call('list_tabs', {}, { lane }))
      stuck = tabs.some((t) => /nid\.naver\.com/i.test(t.url || ''))
    } catch {}
    if (stuck) {
      await closeLaneTabs(lane)
      return { ok: false, reason: '네이버 로그인 화면에 머묾(캡차·추가 인증·보호조치 가능) — 사람 확인 필요' }
    }
  }
  await closeLaneTabs(lane)
  return { ok: true }
}

async function relogin(site) {
  switch (site.relogin?.type) {
    case 'vault_login':
      return reloginVault(site)
    case 'naver_direct':
      return reloginNaverDirect(site)
    case 'naver_click':
      return reloginNaverClick(site)
    default:
      return { ok: false, reason: '복구 전략 없음' }
  }
}

// --- 한도 ------------------------------------------------------------------
function budgetOf(site) {
  return { ...DEF.budget, ...(site.budget ?? {}) }
}
function canAttempt(site, ss) {
  const b = budgetOf(site)
  const dayAgo = now() - 24 * 3600_000
  ss.attempts = ss.attempts.filter((t) => t > dayAgo)
  if (ss.stoppedUntil && ss.stoppedUntil > now())
    return { ok: false, why: `중단 중(${new Date(ss.stoppedUntil).toLocaleTimeString('ko-KR')}까지)` }
  if (ss.attempts.length >= b.perDay) return { ok: false, why: `하루 한도 ${b.perDay}회 도달` }
  const last = ss.attempts[ss.attempts.length - 1]
  if (last && now() - last < b.minGapMin * 60_000) return { ok: false, why: `최소 간격 ${b.minGapMin}분 미경과` }
  return { ok: true }
}

// --- 한 번 점검 ------------------------------------------------------------

// 앱 창이 최소화돼 있으면 페이지가 응답하지 않는다(실측 2026-10-04) — 점검 전에 포커스를 뺏지 않고 복원한다(SW_SHOWNOACTIVATE)
const RESTORE_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class KW { [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n); }
"@
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*samba-browser*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p -and [KW]::IsIconic($p.MainWindowHandle)) { [KW]::ShowWindow($p.MainWindowHandle, 4) | Out-Null; 'restored' } else { 'ok' }
`
function ensureAppWindow() {
  try {
    const r = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', RESTORE_PS], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim()
    if (r === 'restored') log('앱 창이 최소화돼 있어 복원함(포커스는 가져오지 않음)')
  } catch {}
}

// 점검은 한 번에 하나만 돈다 — 두 점검이 같은 레인 탭을 서로 닫아 전부 '판정 불가'가 되는 것을 막는다(실측 2026-10-04)
const CHECK_LOCK = join(DATA_DIR, 'check.lock')
const CHECK_LOCK_STALE_MS = 20 * 60_000
async function acquireCheckLock(waitMs = 25 * 60_000) {
  const t0 = now()
  for (;;) {
    try {
      writeFileSync(CHECK_LOCK, `${process.pid} ${now()}`, { flag: 'wx' })
      return () => {
        try {
          const cur = readFileSync(CHECK_LOCK, 'utf8')
          if (cur.startsWith(`${process.pid} `)) writeFileSync(CHECK_LOCK, '')
        } catch {}
      }
    } catch {
      let stale = false
      try {
        const cur = readFileSync(CHECK_LOCK, 'utf8').trim()
        if (!cur) stale = true
        else {
          const [pid, ts] = cur.split(' ').map(Number)
          let alive = true
          try {
            process.kill(pid, 0)
          } catch {
            alive = false
          }
          stale = !alive || now() - ts > CHECK_LOCK_STALE_MS
        }
      } catch {
        stale = true
      }
      if (stale) {
        try {
          writeFileSync(CHECK_LOCK, '')
          require_unlink()
        } catch {}
        continue
      }
      if (now() - t0 > waitMs) throw new Error('다른 점검이 끝나지 않아 건너뜀')
      await sleep(5000)
    }
  }
}
function require_unlink() {
  try {
    unlinkSync(CHECK_LOCK)
  } catch {}
}
async function checkOnce(opts = {}) {
  const release = await acquireCheckLock()
  try {
    ensureAppWindow()
    return await checkOnceInner(opts)
  } finally {
    release()
  }
}

async function checkOnceInner({ only, dry = false } = {}) {
  const st = loadState()
  const tools = await health().catch((e) => {
    throw e
  })
  if (!tools) throw new BridgeDown('브릿지가 응답하지 않습니다')

  const sites = cfg.sites.filter((s) => !only || s.id === only)
  const naverSite = cfg.sites.find((s) => s.role === 'naver')
  let naverIn = null // true | false | null(모름)

  // 네이버를 먼저 본다 — 소셜 로그인 사이트의 전제 조건
  const ordered = [...sites].sort((a, b) => (a.role === 'naver' ? -1 : 0) - (b.role === 'naver' ? -1 : 0))
  if (naverSite && !ordered.includes(naverSite) && sites.some((s) => s.needsNaver)) ordered.unshift(naverSite)

  for (const site of ordered) {
    const ss = siteState(st, site.id)
    let p
    try {
      p = await probeSignedIn(site)
    } catch (e) {
      if (e instanceof BridgeBusy) {
        log(`[${site.id}] 앱이 바빠 점검을 건너뜀`)
        continue
      }
      throw e
    }
    // 로딩이 느려서 판정 못 한 경우 한 번 더 본다(복구 오발동은 막고, 일시 지연은 흡수한다)
    if (p.verdict === 'unknown') {
      log(`[${site.id}] 판정 불가 — 한 번 더 확인`)
      ensureAppWindow()
      try {
        p = await probeSignedIn(site)
      } catch (e) {
        if (!(e instanceof BridgeBusy)) throw e
      }
    }
    ss.checkedAt = now()
    if (site.role === 'naver') naverIn = p.verdict === 'in' ? true : p.verdict === 'out' ? false : null

    if (p.verdict === 'in') {
      if (ss.status !== 'in') log(`[${site.id}] 로그인 상태 확인`)
      ss.status = 'in'
      ss.detail = ''
      ss.fails = 0
      ss.lastOkAt = now()
    } else if (p.verdict === 'unknown') {
      ss.status = 'unknown'
      ss.detail = p.seen ? `판정 불가(${p.seen})` : '판정 불가(로그인 표시를 찾지 못함)'
      log(`[${site.id}] ${ss.detail} — 복구하지 않음`)
    } else {
      ss.status = 'out'
      ss.detail = '로그아웃됨'
      log(`[${site.id}] 로그아웃 감지`)
      if (dry) {
        log(`[${site.id}] --dry: 복구하지 않음`)
      } else if (!site.relogin) {
        ss.detail = '로그아웃됨 — 복구 전략 없음(사람이 로그인 필요)'
      } else if (site.needsNaver && naverIn === false) {
        ss.status = 'needs_naver'
        ss.detail = '네이버 로그아웃 — 네이버 로그인 후 복구 가능'
        log(`[${site.id}] ${ss.detail}`)
      } else {
        const gate = canAttempt(site, ss)
        if (!gate.ok) {
          ss.detail = `복구 보류: ${gate.why}`
          log(`[${site.id}] ${ss.detail}`)
        } else {
          ss.attempts.push(now())
          log(`[${site.id}] 복구 시도(${site.relogin.type})`)
          const r = await relogin(site)
          if (r.ok) {
            const again = await probeAfterRelogin(site)
            if (again.verdict === 'unknown') {
              // 전략은 끝났지만 화면 확인이 늦다 — 실패로 세지 않고 다음 점검에서 다시 본다
              ss.status = 'unknown'
              ss.detail = '복구 후 확인 지연(다음 점검에서 재확인)'
              log(`[${site.id}] ${ss.detail}`)
            } else if (again.verdict === 'in') {
              ss.status = 'in'
              ss.detail = '복구됨'
              ss.fails = 0
              ss.lastOkAt = now()
              ss.lastReloginAt = now()
              if (site.role === 'naver') naverIn = true // 이제 네이버 소셜 사이트 복구가 가능하다
              log(`[${site.id}] 복구 성공`)
            } else {
              ss.fails += 1
              ss.detail = `복구 후에도 로그인 표시 없음(${again.verdict})`
              log(`[${site.id}] ${ss.detail}`)
            }
          } else {
            ss.fails += 1
            ss.detail = `복구 실패: ${r.reason}`
            log(`[${site.id}] ${ss.detail}`)
          }
          if (ss.fails >= budgetOf(site).maxConsecutiveFails) {
            ss.stoppedUntil = now() + 6 * 3600_000
            log(`[${site.id}] 연속 실패 ${ss.fails}회 — 6시간 중단`)
          }
        }
      }
    }
    saveState(st)
  }
  return st
}

// --- 출력 ------------------------------------------------------------------
function printStatus(st = loadState()) {
  const icon = { in: '🟢 로그인', out: '🔴 로그아웃', needs_naver: '🟠 네이버 필요', unknown: '⚪ 판정불가' }
  say(`\n세션 상태 (마지막 점검 ${st.updatedAt ? new Date(st.updatedAt).toLocaleString('ko-KR', { hour12: false }) : '없음'})`)
  for (const s of cfg.sites) {
    const x = st.sites[s.id]
    if (!x) {
      say(`  ${s.label.padEnd(16)} 점검 기록 없음`)
      continue
    }
    const ago = x.checkedAt ? `${Math.round((now() - x.checkedAt) / 60000)}분 전` : '-'
    say(
      `  ${s.label.padEnd(16)} ${(icon[x.status] ?? x.status).padEnd(12)} 점검 ${ago.padEnd(7)} 24h복구 ${x.attempts?.length ?? 0}회 실패누적 ${x.fails}${x.detail ? ' · ' + x.detail : ''}`
    )
  }
}

// --- 시험용 ----------------------------------------------------------------
async function testRelogin(id) {
  const site = cfg.sites.find((s) => s.id === id)
  if (!site?.relogin) throw new Error('복구 전략이 있는 사이트만 시험할 수 있습니다')
  const lane = laneOf(site)
  await closeLaneTabs(lane)
  const before = await probeSignedIn(site)
  log(`[시험:${id}] 시작 전 상태: ${before.verdict}`)
  // 로그아웃 — 홈의 로그아웃 요소를 눌러 세션을 끊는다
  const r = await call('new_tab', { url: site.home, profile: site.profile ?? DEF.profile }, { lane })
  let outBtn
  for (let i = 0; i < 15 && !outBtn; i++) {
    await sleep(3000)
    const els = parseElements(await call('find_elements', { query: site.markers.in[0].replace(/^~/, '') }, { lane }))
    outBtn = els.find((e) => nameMatches(e.name, site.markers.in[0]) && /button|link/.test(e.role))
  }
  if (!outBtn) throw new Error('로그아웃 요소를 찾지 못함')
  await call('click', { id: outBtn.id, label: outBtn.name }, { lane })
  await sleep(5000)
  await closeLaneTabs(lane)
  const mid = await probeSignedIn(site)
  log(`[시험:${id}] 로그아웃 후 상태: ${mid.verdict}`)
  const rr = await relogin(site)
  log(`[시험:${id}] 복구 전략 결과: ${JSON.stringify(rr)}`)
  const after = await probeAfterRelogin(site)
  log(`[시험:${id}] 복구 후 상태: ${after.verdict}`)
  return after.verdict === 'in'
}

// --- 진입점 ----------------------------------------------------------------
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'once'
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const flag = (name) => argv.includes(name)

async function main() {
  if (cmd === 'status') return printStatus()
  if (cmd === 'once') {
    const st = await checkOnce({ only: opt('--site'), dry: flag('--dry') })
    return printStatus(st)
  }
  if (cmd === 'test-relogin') {
    const ok = await testRelogin(opt('--site'))
    log(ok ? '시험 통과: 로그아웃 → 복구 → 로그인 확인' : '시험 실패')
    process.exit(ok ? 0 : 1)
  }
  if (cmd === 'watch') {
    // 중복 실행 방지 — 같은 계정에 복구가 겹치지 않게 한 개만 돈다
    const lockFile = join(DATA_DIR, 'watch.lock')
    try {
      const pid = Number(readFileSync(lockFile, 'utf8'))
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0)
          log(`이미 실행 중(pid ${pid}) — 종료`)
          process.exit(0)
        } catch {
          /* 죽은 잠금 — 이어서 쓴다 */
        }
      }
    } catch {}
    writeFileSync(lockFile, String(process.pid))
    const unlock = () => {
      try {
        if (readFileSync(lockFile, 'utf8') === String(process.pid)) writeFileSync(lockFile, '')
      } catch {}
    }
    process.on('exit', unlock)
    process.on('SIGINT', () => process.exit(0))
    process.on('SIGTERM', () => process.exit(0))
    log(`세션 관리자 시작(pid ${process.pid})`)
    const base = Number(opt('--interval') ?? 15)
    for (;;) {
      try {
        printStatus(await checkOnce({ dry: flag('--dry') }))
      } catch (e) {
        if (e instanceof BridgeDown) log(`앱 연결 대기: ${e.message}`)
        else log(`점검 오류: ${String(e.message ?? e).slice(0, 160)}`)
      }
      const wait = (base + (Math.random() * 4 - 2)) * 60_000 // ±2분 흔들림
      await sleep(Math.max(60_000, wait))
    }
  }
  say('사용: node keeper.mjs once|watch|status|test-relogin [--site ID] [--dry] [--interval 분]')
}

main().catch((e) => {
  log(`오류: ${String(e.message ?? e)}`)
  process.exit(1)
})
