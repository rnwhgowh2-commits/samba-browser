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
import { call as bridgeCall, health, postJson, sleep, BridgeDown, BridgeBusy, BridgeTimeout } from './bridge.mjs'

// 모든 브릿지 호출에 기본 제한 시간을 둔다(부하로 앱이 늦어도 한 호출이 오래 붙잡지 못하게). 호출마다 timeoutMs 로 바꿀 수 있다
const DEFAULT_CALL_MS = 60_000
const call = (tool, args = {}, opts = {}) => bridgeCall(tool, args, { timeoutMs: DEFAULT_CALL_MS, ...opts })
import { syncFromSamba } from './samba-sync.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(process.env.APPDATA ?? HERE, 'SAMBA Browser', 'session-keeper')
const STATE_FILE = join(DATA_DIR, 'state.json')
const LOG_FILE = join(DATA_DIR, 'keeper.log')
mkdirSync(DATA_DIR, { recursive: true })

// 한 사이트에 계정이 여럿이면 계정마다 프로필(쿠키 저장소)을 나눠 따로 점검·복구한다.
// sites.json 의 site.accounts = [{ profile, accountLabel? }] — 키마스터 계정 라벨은 프로필 이름과 같게 두면 login 도구가 자동으로 고른다
function loadConfig() {
  const c = JSON.parse(readFileSync(join(HERE, 'sites.json'), 'utf8'))
  c.sites = c.sites
    .filter((site) => site.enabled !== false)
    .flatMap((site) => {
      if (!Array.isArray(site.accounts) || site.accounts.length === 0) return [{ ...site, baseId: site.id, laneKey: site.id }]
      return site.accounts.map((acc, i) => ({
        ...site,
        accounts: undefined,
        baseId: site.id,
        id: `${site.id}/${acc.profile}`,
        laneKey: `${site.id}-${i + 1}`.replace(/[^A-Za-z0-9_.@-]/g, '_'),
        label: `${site.label}(${acc.profile})`,
        profile: acc.profile,
        // 계정마다 복구 방식을 따로 줄 수 있다(acc.relogin) — 한 계정만 먼저 시험할 때 쓴다(2026-10-17 네이버)
        relogin: (acc.relogin !== undefined ? acc.relogin : site.relogin)
          ? { ...(acc.relogin ?? site.relogin), accountLabel: acc.accountLabel ?? acc.profile }
          : null
      }))
    })
  return c
}
let cfg = loadConfig()
let DEF = cfg.defaults
// watch 는 점검마다 sites.json 을 다시 읽는다 — 사이트를 늘리거나 고쳐도 재시작이 필요 없다. 깨진 파일이면 이전 설정을 그대로 쓴다
function reloadConfig() {
  try {
    cfg = loadConfig()
    DEF = cfg.defaults
  } catch (e) {
    log(`sites.json 을 읽지 못해 이전 설정으로 점검: ${String(e.message).slice(0, 80)}`)
  }
}

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
const laneOf = (site) => `keeper-${site.laneKey ?? site.id}`
const tabIdOf = (r) => r.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]

async function closeLaneTabs(lane) {
  try {
    const tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    for (const t of tabs) await call('close_tab', { id: t.id }, { lane }).catch(() => {})
  } catch {}
}

// 사이트 방화벽·접속 차단·오류 화면 — 이런 화면은 로그인 여부를 말해 주지 않는다(판정 불가)
const BLOCKED_PAGE = /Web firewall|Access Denied|접근이 (차단|제한)|Request blocked|403 Forbidden|404 - page Not Found|일시적인 오류|Request Header Or Cookie Too Large|400 Bad Request/i

// 판정 중 호출 하나가 기다리는 최대 시간. 부하로 앱이 늦어도 한 사이트가 점검 한 바퀴를 붙잡지 못하게 한다
const PROBE_CALL_MS = 40_000

// 쿠키가 쌓여 서버가 사이트 전체를 막는 화면 — 로그인 여부를 말해 주지 않지만, 그 사이트 쿠키를 지우면 풀린다
const COOKIE_TOO_LARGE = /Request Header Or Cookie Too Large|400 Bad Request/i
const COOKIE_TOO_LARGE_SEEN = '쿠키 과다 오류 화면'

/**
 * 주소로 판정한다(삼바 확장앱 자동 로그인과 같은 방식) — 로그인이 필요한 확인 페이지(probe.url)를 열어,
 * 로그인 화면(probe.loginRe)으로 넘어가면 out, 그 페이지에 머물면 in. 차단·오류 화면이면 unknown
 */
async function probeByUrl(site, { keepTab = false } = {}) {
  const lane = laneOf(site)
  await closeLaneTabs(lane)
  const r = await call('new_tab', { url: site.probe.url, profile: site.profile ?? DEF.profile }, { lane, retries: 2, timeoutMs: PROBE_CALL_MS })
  const tabId = tabIdOf(r)
  const loginRe = new RegExp(site.probe.loginRe, 'i')
  const deadline = now() + (site.checkTimeoutSec ?? DEF.checkTimeoutSec) * 1000
  let verdict = 'unknown'
  let seen = ''
  let stableIn = 0
  try {
    await sleep(site.probe.settleMs ?? 6000)
    while (now() < deadline) {
      let url = ''
      try {
        const tabs = JSON.parse(await call('list_tabs', {}, { lane, retries: 1, timeoutMs: PROBE_CALL_MS }))
        url = (tabs.find((t) => t.id === tabId) ?? tabs[0])?.url ?? ''
      } catch (e) {
        seen = String(e.message).slice(0, 80)
      }
      if (url && loginRe.test(url)) {
        verdict = 'out'
        break
      }
      if (url && !/^about:|^samba:/.test(url)) {
        let txt = ''
        let readOk = true
        try {
          txt = await call('get_page', { query: site.probe.inText ?? '로그' }, { lane, retries: 1, timeoutMs: PROBE_CALL_MS })
        } catch (e) {
          readOk = false
          seen = `페이지 조회 실패: ${String(e.message ?? e).slice(0, 40)}`
        }
        // 화면을 읽지 못했으면 '변함없음'의 증거가 아니다 — 연속 확인 횟수를 지우고 다시 본다
        if (!readOk) {
          stableIn = 0
          await sleep(3000)
          continue
        }
        if (COOKIE_TOO_LARGE.test(txt)) {
          seen = COOKIE_TOO_LARGE_SEEN
          break
        }
        if (BLOCKED_PAGE.test(txt)) {
          seen = '사이트 차단·오류 화면'
          break
        }
        if (site.probe.outText && new RegExp(site.probe.outText, 'i').test(txt)) {
          verdict = 'out'
          break
        }
        // 로그인 화면으로 늦게 넘어가는 사이트가 있어 두 번 연속 같은 결론일 때만 in
        if (++stableIn >= 2) {
          verdict = 'in'
          break
        }
      }
      await sleep(3000)
    }
  } finally {
    if (!keepTab && tabId) await call('close_tab', { id: tabId }, { lane, retries: 1, timeoutMs: PROBE_CALL_MS }).catch(() => {})
  }
  return { verdict, seen }
}

/** 홈을 레인 탭으로 열어 로그인 표시를 읽는다. in | out | unknown */
async function probeSignedIn(site, { keepTab = false } = {}) {
  if (site.probe) return probeByUrl(site, { keepTab })
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

/**
 * 로그인된 계정이 의도한 계정인지 확인한다(여러 계정을 프로필로 나눌 때 필수 — 다른 계정으로 로그인된 채 쓰이는 사고 방지).
 * site.identity = { url, pattern(정규식 문자열, 첫 그룹이 아이디) }. 기대 아이디는 relogin.accountLabel(= 키마스터 라벨).
 * 값은 로그에 앞 3글자와 길이만 남긴다. 판단 못 하면 'unknown'(건드리지 않음)
 */
async function probeIdentity(site) {
  if (!site.identity) return { verdict: 'skip' }
  const lane = laneOf(site)
  const expected = String(site.relogin?.accountLabel ?? '').trim().toLowerCase()
  if (!expected) return { verdict: 'skip' }
  await closeLaneTabs(lane)
  const r = await call('new_tab', { url: site.identity.url, profile: site.profile ?? DEF.profile }, { lane })
  const tabId = tabIdOf(r)
  let got = ''
  try {
    for (let i = 0; i < 4 && !got; i++) {
      await sleep(i === 0 ? 5000 : 3000)
      const txt = await call('get_page', {}, { lane })
      const m = new RegExp(site.identity.pattern).exec(txt)
      if (m) got = m[1].trim().toLowerCase()
    }
  } finally {
    if (tabId) await call('close_tab', { id: tabId }, { lane }).catch(() => {})
  }
  if (!got) return { verdict: 'unknown' }
  const ok = got === expected || expected.endsWith('_' + got)
  return { verdict: ok ? 'match' : 'mismatch', mask: `${got.slice(0, 3)}***(${got.length}자)`, wantMask: `${expected.slice(0, 3)}***(${expected.length}자)` }
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
  // 로그인 화면이 늦게 뜨는 사이트가 있어 버튼이 보일 때까지 최대 20초 다시 찾는다(2026-10-17 롯데ON '버튼을 찾지 못함' 실측 — 버튼은 있었다)
  // 버튼·링크를 우선하고, 이름이 짧은(=그 글자뿐인) 요소를 고른다 — 페이지 전체를 감싼 긴 clickable 을 누르지 않게
  let btn
  for (let i = 0; i < 5 && !btn; i++) {
    await sleep(i === 0 ? 5000 : 4000)
    const els = parseElements(await call('find_elements', { query: site.relogin.text }, { lane }).catch(() => ''))
    btn = els
      .filter((e) => /네이버|naver/i.test(e.name) && e.name.length <= 20 && /^(button|link|clickable)$/.test(e.role))
      .sort((a, b) => (/^(button|link)$/.test(b.role) ? 1 : 0) - (/^(button|link)$/.test(a.role) ? 1 : 0) || a.name.length - b.name.length)[0]
  }
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

/** 제출 뒤에도 탭이 로그인 주소에 머물러 있으면 이름이 정확히 같은 버튼을 한 번 누른다 */
async function clickSubmitIfStuck(lane, text) {
  try {
    await sleep(3000)
    const tabs = JSON.parse(await call('list_tabs', {}, { lane }))
    if (!tabs.length || !tabs.some((t) => /login|signin/i.test(t.url || ''))) return
    const els = parseElements(await call('find_elements', { query: text }, { lane }))
    const btn = els.find((e) => e.role === 'button' && e.name === text)
    if (!btn) return
    log(`login 제출이 먹지 않아 '${text}' 버튼을 직접 누름`)
    await call('click', { id: btn.id, label: text }, { lane })
  } catch (e) {
    log(`제출 버튼 직접 클릭 실패: ${String(e.message ?? e).slice(0, 100)}`)
  }
}

/** 키마스터에 저장된 계정으로 앱의 login 도구가 입력한다 — 비밀번호는 이 스크립트를 지나지 않는다 */
async function reloginVault(site) {
  const lane = laneOf(site)
  await closeLaneTabs(lane)
  await call('new_tab', { url: site.relogin.loginUrl, profile: site.profile ?? DEF.profile }, { lane })
  // 로그인 화면이 실제로 뜰 때까지 기다린다 — 프록시를 거치는 프로필은 6초 안에 안 떠 login 도구가 'host unknown' 을 냈다(2026-10-17 ABC마트)
  const wantHost = new URL(site.relogin.loginUrl).hostname.split('.').slice(-2).join('.')
  const loadDeadline = now() + (site.relogin.loadWaitMs ?? 30_000)
  await sleep(4000)
  while (now() < loadDeadline) {
    let url = ''
    try {
      url = JSON.parse(await call('list_tabs', {}, { lane }))[0]?.url ?? ''
    } catch {}
    if (url.includes(wantHost)) break
    await sleep(2000)
  }
  await sleep(3000)
  // 로그인 화면에서 먼저 눌러야 할 버튼이 있는 사이트(29CM: '무신사 통합계정 가입 및 로그인' → member.one.musinsa.com, 2026-10-24)
  if (site.relogin.preClick) {
    const hostWant = site.relogin.preClickHost ?? 'musinsa.com'
    let moved = false
    for (let i = 0; i < 8 && !moved; i++) {
      try {
        const els = parseElements(await call('find_elements', { query: site.relogin.preClick }, { lane }))
        const btn = els.find((e) => e.role === 'button' && e.name === site.relogin.preClick)
        if (btn) {
          await call('click', { id: btn.id, label: site.relogin.preClick }, { lane })
          for (let j = 0; j < 8 && !moved; j++) {
            await sleep(2000)
            const tabs = JSON.parse(await call('list_tabs', {}, { lane }))
            moved = tabs.some((t) => (t.url || '').includes(hostWant))
          }
        } else await sleep(2500)
      } catch {}
    }
    if (!moved) {
      await closeLaneTabs(lane)
      return { ok: false, reason: `'${site.relogin.preClick}' 버튼을 눌러도 ${hostWant} 로그인 화면으로 가지 않음` }
    }
    await sleep(3000)
  }
  let res = ''
  try {
    // 'host unknown: navigate to the site first' 는 login 도구가 아직 사이트 화면을 못 본 것이다(부하로 로딩이 늦음, SSF·LF몰 실측)
    // — 로그인 화면으로 다시 이동해 잠깐 기다린 뒤 최대 2번 더 시도한다
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await call('login', site.relogin.accountLabel ? { accountLabel: site.relogin.accountLabel } : {}, { lane })
      if (!/^host unknown/i.test(res)) break
      log(`[${site.id}] 로그인 화면을 아직 못 읽음 — 다시 이동 후 재시도(${attempt + 1}/2)`)
      await call('navigate', { url: site.relogin.loginUrl }, { lane, retries: 1, timeoutMs: PROBE_CALL_MS }).catch(() => {})
      await sleep(8000 + attempt * 6000)
    }
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
  // login 도구가 '제출했다'고 답해도 아무 일도 안 일어나는 사이트(실측 2026-10-24: 무신사 통합 로그인 member.one.musinsa.com)는
  // 같은 탭에 채워진 폼이 그대로 남는다 — relogin.submitClick 글자의 버튼을 직접 한 번 누른다(값은 이미 채워져 있어 비밀번호는 지나지 않는다)
  if (site.relogin.submitClick && low.startsWith('submitted')) await clickSubmitIfStuck(lane, site.relogin.submitClick)
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
  // (naverForm: 네이버 아이디로 로그인하는 다른 항목 — role 'naver' 는 네이버 열쇠 판정에 쓰여 따로 둔다)
  if (site.role === 'naver' || site.naverForm) {
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
const CHECK_LOCK_STALE_MS = 90 * 60_000
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

/** 앱의 사이트별 쿠키 삭제 입구(POST /cookies/clear)를 부른다. { removed, failed, error } — 실패 원인을 로그에 남길 수 있게 구분해 돌려준다 */
async function clearCookiesViaBridge(site) {
  try {
    const r = await postJson('/cookies/clear', { profile: site.profile ?? DEF.profile, host: site.cookieHost, automation: true })
    if (r.status === 200 && r.json?.ok) return { removed: Number(r.json.removed) || 0, failed: Number(r.json.failed) || 0, error: '' }
    return { removed: 0, failed: 0, error: `HTTP ${r.status} ${String(r.json?.error ?? '').slice(0, 40)}` }
  } catch (e) {
    return { removed: 0, failed: 0, error: String(e.message ?? e).slice(0, 60) }
  }
}

/** 판정 한 번. 앱 응답 지연(BridgeTimeout)은 그 사이트만 '판정 불가'로 두고, 바빠서 못 했으면 null */
async function probeSafe(site) {
  try {
    return await probeSignedIn(site)
  } catch (e) {
    if (e instanceof BridgeBusy) return null
    if (e instanceof BridgeTimeout) return { verdict: 'unknown', seen: '앱 응답 지연' }
    throw e
  }
}

async function checkOnceInner({ only, dry = false } = {}) {
  const st = loadState()
  const tools = await health().catch((e) => {
    throw e
  })
  if (!tools) throw new BridgeDown('브릿지가 응답하지 않습니다')

  const sites = cfg.sites.filter((s) => !only || s.id === only || s.baseId === only)
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
      if (e instanceof BridgeTimeout) {
        log(`[${site.id}] ${e.message} — 이 사이트는 판정 불가로 두고 다음으로`)
        ss.checkedAt = now()
        ss.status = 'unknown'
        ss.detail = '판정 불가(앱 응답 지연)'
        saveState(st)
        continue
      }
      throw e
    }
    // 쿠키 과다로 사이트가 막혔으면(site.cookieHost 가 있는 사이트) 그 사이트 쿠키만 지우고 다시 본다 — 지우면 로그아웃이 되므로 이어서 복구가 돈다
    if (p.verdict === 'unknown' && p.seen === COOKIE_TOO_LARGE_SEEN && site.cookieHost && !dry) {
      const cl = await clearCookiesViaBridge(site)
      log(`[${site.id}] 쿠키 과다 — ${site.cookieHost} 쿠키 ${cl.removed}개 삭제${cl.failed ? `, ${cl.failed}개 못 지움` : ''}${cl.error ? ` (오류: ${cl.error})` : ''}`)
      if (cl.removed > 0) {
        ensureAppWindow()
        p = (await probeSafe(site)) ?? p
      }
    }
    // 로딩이 느려서 판정 못 한 경우 한 번 더 본다(복구 오발동은 막고, 일시 지연은 흡수한다)
    if (p.verdict === 'unknown') {
      log(`[${site.id}] 판정 불가 — 한 번 더 확인`)
      ensureAppWindow()
      p = (await probeSafe(site)) ?? p
    }
    ss.checkedAt = now()
    if (site.role === 'naver') naverIn = p.verdict === 'in' ? true : p.verdict === 'out' ? false : null

    if (p.verdict === 'in' && site.identity) {
      const idr = await probeIdentity(site)
      if (idr.verdict === 'mismatch') {
        ss.status = 'wrong_account'
        ss.detail = `계정 불일치 — 로그인된 ${idr.mask}, 기대 ${idr.wantMask} (사람 확인 필요, 자동 조치 안 함)`
        log(`[${site.id}] ${ss.detail}`)
        saveState(st)
        continue
      }
      if (idr.verdict === 'unknown') {
        ss.status = 'unknown'
        ss.detail = '로그인은 됐으나 계정 확인 불가(건드리지 않음)'
        log(`[${site.id}] ${ss.detail}`)
        saveState(st)
        continue
      }
    }
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
            } else if (again.verdict === 'in' && site.identity && (await probeIdentity(site)).verdict === 'mismatch') {
              ss.status = 'wrong_account'
              ss.detail = '복구 후 다른 계정으로 로그인됨 — 사람 확인 필요'
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
  const icon = { in: '🟢 로그인', out: '🔴 로그아웃', needs_naver: '🟠 네이버 필요', unknown: '⚪ 판정불가', wrong_account: '🟣 계정불일치' }
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

// --- 삼바 설정탭 → 키마스터 자동 동기화 -------------------------------------
// sites.json 의 sambaSync.autoEveryHours 마다 한 번(기본 끔). 비밀번호는 DB → 이 프로세스 메모리 → 로컬 앱으로만 가고
// 로그에는 사이트별 건수만 남긴다. 키마스터가 잠겨 있거나 앱이 꺼져 있으면 다음 주기에 다시 한다
async function autoSyncFromSamba() {
  const hours = Number(cfg.sambaSync?.autoEveryHours ?? 0)
  if (!hours) return
  const st = loadState()
  if (st.lastSambaSyncAt && now() - st.lastSambaSyncAt < hours * 3600_000) return
  try {
    const r = await syncFromSamba({ sites: cfg.sambaSync?.sites ?? ['ALL'] })
    log(`삼바 계정 자동 동기화: ${JSON.stringify(r)}`)
    if (r.sent > 0) {
      const st2 = loadState()
      st2.lastSambaSyncAt = now()
      saveState(st2)
    }
  } catch (e) {
    log(`삼바 계정 자동 동기화 실패: ${String(e.message ?? e).slice(0, 120)}`)
  }
}

// --- 진입점 ----------------------------------------------------------------
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'once'
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const flag = (name) => argv.includes(name)

/**
 * 다음 점검까지 쉬되, 그 사이 앱이 재시작되면 곧바로 깨어난다.
 * 앱을 다시 켜면 세션 쿠키가 풀린 사이트가 생기므로 다음 정기 점검(수십 분)을 기다리지 않고 바로 훑는다.
 * 재시작 신호 두 가지: ① 브릿지 연결이 두 번 연속 끊겼다가 돌아옴 ② 지켜 보던 계정 탭이 전부 사라짐(15초 안에 끝난 빠른 재시작).
 * 앱이 바빠 409 를 주는 것은 종료가 아니므로 어느 쪽에도 세지 않는다
 */
async function sleepUnlessAppRestarted(totalMs) {
  const end = now() + totalMs
  let misses = 0
  let wasDown = false
  while (now() < end) {
    await sleep(15_000)
    let count = null
    try {
      count = JSON.parse(await call('list_tabs', {}, { lane: OPEN_TABS_LANE, retries: 1 })).length
    } catch (e) {
      if (e instanceof BridgeBusy) continue
      if (++misses >= 2) wasDown = true
      continue
    }
    misses = 0
    // 세션 관리자가 열어 둔 계정 탭이 있었는데 레인이 비었으면 앱이 다시 켜진 것이다(15초 안에 끝난 재시작 포함)
    if (wasDown || (openedByKeeper.size > 0 && count === 0)) {
      log('앱 재시작 감지 — 30초 뒤 바로 점검')
      await sleep(30_000)
      await openAccountTabs().catch(() => {})
      return
    }
  }
}

// 소싱처·계정별 탭을 열어 둔다 — 사이드바에 소싱처 묶음으로 보이고, 계정마다 로그인된 화면을 바로 볼 수 있다.
// 앱을 재시작하면 탭이 사라지므로 재시작 감지 때와 세션 관리자 시작 때 연다(이미 이 레인 탭이 있으면 다시 열지 않는다).
// 열 주소: site.openUrl → site.probe.url → site.home. site.openTab === false 이면 제외
const OPEN_TABS_LANE = 'keeper-open-tabs'
// 이 프로세스가 연 계정 탭: 탭 id → { id(소싱처), url, profile }. 계획과 비교해 빠진 것만 연다
const openedByKeeper = new Map()
const planKey = (p) => `${p.id}|${p.profile}`

function accountTabPlan() {
  const plan = []
  for (const site of cfg.sites) {
    if (site.openTab === false) continue
    const url = site.openUrl ?? site.probe?.url ?? site.home
    if (!url) continue
    const profiles = site.accounts?.length ? site.accounts.map((a) => a.profile) : [site.profile ?? DEF.profile]
    for (const profile of [...new Set(profiles)].filter((x) => !x.startsWith('tmp-'))) plan.push({ id: site.id, url, profile })
  }
  return plan
}

async function openAccountTabs() {
  let existing = []
  try {
    existing = JSON.parse(await call('list_tabs', {}, { lane: OPEN_TABS_LANE }))
  } catch (e) {
    log(`계정 탭 열기 건너뜀: ${String(e.message ?? e).slice(0, 60)}`)
    return
  }
  // 이전 세션 관리자가 연 탭은 어느 계정 것인지 알 수 없으니 닫고 새로 연다(레인은 세션 관리자 전용)
  if (openedByKeeper.size === 0 && existing.length > 0) {
    for (const t of existing) await call('close_tab', { id: t.id }, { lane: OPEN_TABS_LANE }).catch(() => {})
    existing = []
  }
  // 사라진 탭(사용자가 닫음·앱 재시작)은 목록에서 뺀다
  const alive = new Set(existing.map((t) => t.id))
  for (const id of [...openedByKeeper.keys()]) if (!alive.has(id)) openedByKeeper.delete(id)
  const have = new Set([...openedByKeeper.values()].map(planKey))
  const todo = accountTabPlan().filter((p) => !have.has(planKey(p)))
  if (todo.length === 0) return
  const failed = []
  let n = 0
  for (const item of todo) {
    try {
      const r = await call('new_tab', { url: item.url, profile: item.profile }, { lane: OPEN_TABS_LANE })
      openedByKeeper.set(tabIdOf(r), item)
      n++
    } catch (e) {
      if (e instanceof BridgeDown) return
      failed.push(item)
    }
    await sleep(2500)
  }
  log(`계정별 탭 ${n}개 열기${failed.length ? ` (실패 ${failed.length}개: ${failed.map((f) => f.profile).join(',')} — 다음 회차에 다시 시도)` : ''}`)
}

async function main() {
  if (cmd === 'status') return printStatus()
  if (cmd === 'once') {
    const st = await checkOnce({ only: opt('--site'), dry: flag('--dry') })
    return printStatus(st)
  }
  if (cmd === 'sync-samba') {
    // 삼바웨이브 계정을 키마스터로 동기화(sites.json 의 sambaSync.sites, --sites 로 덮어쓸 수 있다)
    const sites = (opt('--sites') ?? (cfg.sambaSync?.sites ?? ['ALL']).join(',')).split(',').map((x) => x.trim()).filter(Boolean)
    const r = await syncFromSamba({ sites, dry: flag('--dry') })
    log(`삼바 계정 동기화: ${JSON.stringify(r)}`)
    say(JSON.stringify(r, null, 2))
    if (!flag('--dry') && r.sent > 0) {
      const st = loadState()
      st.lastSambaSyncAt = now()
      saveState(st)
    }
    return
  }
  if (cmd === 'setup-accounts') {
    // 키마스터에 저장된 해당 사이트 계정(라벨)을 읽어 계정마다 프로필을 배정하고 sites.json 에 기록한다. 비밀번호는 읽지 않는다
    const base = cfg.sites.find((x) => (x.baseId ?? x.id) === opt('--site'))
    if (!base) throw new Error('--site 로 사이트 ID 를 주세요(예: MUSINSA)')
    const lane = 'keeper-setup'
    ensureAppWindow()
    await closeLaneTabs(lane)
    await call('new_tab', { url: base.home }, { lane })
    let raw = ''
    for (let i = 0; i < 6; i++) {
      await sleep(5000)
      raw = await call('list_accounts', {}, { lane })
      if (!/host unknown/.test(raw)) break
    }
    await closeLaneTabs(lane)
    let list = []
    try {
      const parsed = JSON.parse(raw)
      list = Array.isArray(parsed) ? parsed : (parsed.accounts ?? [])
    } catch {}
    const labels = [...new Set(list.map((a) => a.label).filter(Boolean))]
    if (!labels.length) throw new Error('키마스터에서 이 사이트 계정을 찾지 못함: ' + raw.slice(0, 120))
    const prefix = (base.baseId ?? base.id).toLowerCase()
    const accounts = labels.map((label, i) => ({ profile: `${prefix}-${i + 1}`, accountLabel: label }))
    const file = join(HERE, 'sites.json')
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const t = j.sites.find((x) => x.id === (base.baseId ?? base.id))
    t.accounts = accounts
    writeFileSync(file, JSON.stringify(j, null, 2), 'utf8')
    say(`${labels.length}개 계정에 프로필을 배정했습니다: ` + accounts.map((a) => a.profile).join(', '))
    return
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
    await openAccountTabs().catch(() => {})
    for (;;) {
      reloadConfig()
      // 앱이 점검 도중에 재시작돼 탭이 사라졌어도 다음 회차에서 다시 연다(이 레인 탭이 남아 있으면 아무것도 안 한다)
      await openAccountTabs().catch(() => {})
      await autoSyncFromSamba()
      try {
        printStatus(await checkOnce({ dry: flag('--dry') }))
      } catch (e) {
        if (e instanceof BridgeDown) log(`앱 연결 대기: ${e.message}`)
        else log(`점검 오류: ${String(e.message ?? e).slice(0, 160)}`)
      }
      const wait = (base + (Math.random() * 4 - 2)) * 60_000 // ±2분 흔들림
      await sleepUnlessAppRestarted(Math.max(60_000, wait))
    }
  }
  say('사용: node keeper.mjs once|watch|status|test-relogin [--site ID] [--dry] [--interval 분]')
}

main().catch((e) => {
  log(`오류: ${String(e.message ?? e)}`)
  process.exit(1)
})
