// 삼바웨이브 → 삼바 브라우저 키마스터 계정 동기화.
// 같은 PC 의 삼바 DB(backend\.env 의 READ_DB_*)를 읽기 전용으로 조회해, 앱 브릿지의 로컬 입구(/vault/import-logins)로 보낸다.
// 비밀번호는 이 프로세스 메모리에서 로컬 앱(127.0.0.1)으로만 간다 — 파일·로그·콘솔에 남기지 않는다.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { postJson } from './bridge.mjs'

const ENV_FILE = process.env.SAMBA_BACKEND_ENV ?? 'C:\\Users\\rnwhg\\Desktop\\samba-wave-main\\backend\\.env'
const PSQL = process.env.PSQL_EXE ?? 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe'

// 사이트별 로그인 주소(가져오기가 사이트 도메인을 알아보는 데 쓴다).
// 키마스터는 (등록 도메인, 아이디)로 같은 계정을 찾으므로 주소가 바뀌어도 중복이 생기지 않는다.
// 값은 삼바 확장앱 자동 로그인(extension/background-autologin.js)의 실측 주소를 따른다(2026-10-17)
export const LOGIN_URL = {
  MUSINSA: 'https://www.musinsa.com/auth/login',
  SSG: 'https://member.ssg.com/member/login.ssg',
  LOTTEON: 'https://www.lotteon.com/p/member/login/common',
  ABCmart: 'https://www.a-rt.com/login',
  '29CM': 'https://www.29cm.co.kr/login',
  GSShop: 'https://www.gsshop.com/cust/login/login.gs',
  FashionPlus: 'https://www.fashionplus.co.kr/auth/login?redirect_to_after_login=%2F',
  LOTTEIMALL: 'https://www.lotteimall.com/member/login/forward.LCLoginMem.lotte',
  GALLERIAMALL: 'https://www.galleria.co.kr/login/login.action',
  HMALL: 'https://www.hmall.com/mo/cob/loginForm',
  LFmall: 'https://www.lfmall.co.kr/app/login',
  SSF: 'https://www.ssfshop.com/public/member/login',
  TheHyundai: 'https://hi.thehyundai.com/login',
  Nike: 'https://www.nike.com/kr/login',
  NAVERSTORE: 'https://nid.naver.com/nidlogin.login',
  GMARKET: 'https://signin.gmarket.co.kr/LogIn/LogIn',
  AUCTION: 'https://signin.auction.co.kr/Authenticate/login.aspx'
}
// 설정탭에 아이디·비밀번호가 있으면 로그인 방식 칸(naver 등)과 상관없이 그 사이트 계정으로 저장한다(2026-10-17 사장님 지시)
/** 계정 한 줄을 키마스터 주소로 바꾼다. 사이트 로그인 주소를 모르면 null */
export function loginUrlOf(row) {
  return LOGIN_URL[row.site] ?? null
}

function readEnv() {
  const kv = {}
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line)
    if (m) kv[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  for (const k of ['READ_DB_HOST', 'READ_DB_PORT', 'READ_DB_USER', 'READ_DB_PASSWORD', 'READ_DB_NAME'])
    if (!kv[k]) throw new Error(`${ENV_FILE} 에 ${k} 가 없음`)
  return kv
}

function psqlJson(kv, sql) {
  return new Promise((resolve, reject) => {
    const p = spawn(PSQL, ['-h', kv.READ_DB_HOST, '-p', kv.READ_DB_PORT, '-U', kv.READ_DB_USER, '-d', kv.READ_DB_NAME, '-X', '-A', '-t'], {
      env: { ...process.env, PGPASSWORD: kv.READ_DB_PASSWORD, PGCLIENTENCODING: 'UTF8' },
      windowsHide: true
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('psql 실패: ' + err.slice(0, 120)))))
    p.stdin.end(sql)
  })
}

/**
 * @param {{sites?: string[], dry?: boolean}} opt  sites 에 'ALL' 이 있으면 설정탭의 모든 활성 계정
 * @returns {{found:number, sent:number, bySite:Record<string,number>, unsupported:string[], added?:number, updated?:number, skipped?:number, note?:string}}
 */
export async function syncFromSamba({ sites = ['MUSINSA'], dry = false } = {}) {
  const kv = readEnv()
  const all = sites.includes('ALL')
  const list = sites.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
  const sql = `select coalesce(json_agg(json_build_object('site', site_name, 'name', site_name || ' ' || account_label, 'method', coalesce(additional_fields->>'login_method',''), 'username', username, 'password', password) order by site_name, account_label), '[]'::json)
from samba_sourcing_account
where is_active and tenant_id is not null ${all ? '' : `and site_name in (${list})`} and coalesce(username,'')<>'' and coalesce(password,'')<>''`
  let rows = JSON.parse((await psqlJson(kv, sql)) || '[]')
  const found = rows.length
  // 사이트별 보낼 수·주소를 모르는 사이트(값은 세지 않고 이름만)
  const bySite = {}
  const unsupported = new Set()
  let logins = []
  for (const r of rows) {
    const url = loginUrlOf(r)
    if (!url) {
      unsupported.add(r.site)
      continue
    }
    bySite[r.site] = (bySite[r.site] ?? 0) + 1
    if (!dry) logins.push({ url, name: r.name, username: r.username, password: r.password })
  }
  rows = null
  const base = { found, bySite, unsupported: [...unsupported] }
  if (dry) return { ...base, sent: 0, note: '--dry: 보내지 않음' }
  if (logins.length === 0) return { ...base, sent: 0, note: '보낼 계정 없음' }
  const sent = logins.length
  const r = await postJson('/vault/import-logins', { logins })
  logins.length = 0
  logins = null
  if (r.status === 423) return { ...base, sent: 0, note: '키마스터가 잠겨 있어 보내지 못함' }
  if (r.status !== 200 || !r.json.ok) throw new Error(`앱이 거절함: ${r.status} ${r.json.error ?? ''}`)
  return { ...base, sent, added: r.json.added, updated: r.json.updated, skipped: r.json.skipped }
}
