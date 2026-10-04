// 삼바웨이브 → 삼바 브라우저 키마스터 계정 동기화.
// 같은 PC 의 삼바 DB(backend\.env 의 READ_DB_*)를 읽기 전용으로 조회해, 앱 브릿지의 로컬 입구(/vault/import-logins)로 보낸다.
// 비밀번호는 이 프로세스 메모리에서 로컬 앱(127.0.0.1)으로만 간다 — 파일·로그·콘솔에 남기지 않는다.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { postJson } from './bridge.mjs'

const ENV_FILE = process.env.SAMBA_BACKEND_ENV ?? 'C:\\Users\\rnwhg\\Desktop\\samba-wave-main\\backend\\.env'
const PSQL = process.env.PSQL_EXE ?? 'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe'

// 사이트별 로그인 주소(가져오기가 사이트 도메인을 알아보는 데 쓴다)
const LOGIN_URL = {
  MUSINSA: 'https://www.musinsa.com/auth/login',
  SSG: 'https://member.ssg.com/member/login.ssg',
  LOTTEON: 'https://www.lotteon.com/p/member/login/common',
  ABCmart: 'https://www.a-rt.com/login',
  '29CM': 'https://www.29cm.co.kr/login',
  GSShop: 'https://www.gsshop.com/member/login.gs',
  FashionPlus: 'https://www.fashionplus.co.kr/login',
  LOTTEIMALL: 'https://www.lotteimall.com/member/login/forward.lotte'
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
 * @param {{sites?: string[], dry?: boolean}} opt
 * @returns {{found:number, sent:number, added?:number, updated?:number, skipped?:number, note?:string}}
 */
export async function syncFromSamba({ sites = ['MUSINSA'], dry = false } = {}) {
  const kv = readEnv()
  const list = sites.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')
  const sql = `select coalesce(json_agg(json_build_object('site', site_name, 'name', site_name || ' ' || account_label, 'username', username, 'password', password) order by site_name, account_label), '[]'::json)
from samba_sourcing_account
where is_active and site_name in (${list}) and coalesce(username,'')<>'' and coalesce(password,'')<>''`
  let rows = JSON.parse((await psqlJson(kv, sql)) || '[]')
  const found = rows.length
  if (dry) {
    rows = null
    return { found, sent: 0, note: '--dry: 보내지 않음' }
  }
  const logins = rows
    .filter((r) => LOGIN_URL[r.site])
    .map((r) => ({ url: LOGIN_URL[r.site], name: r.name, username: r.username, password: r.password }))
  rows = null
  if (logins.length === 0) return { found, sent: 0, note: '보낼 계정 없음' }
  const r = await postJson('/vault/import-logins', { logins })
  logins.length = 0
  if (r.status === 423) return { found, sent: 0, note: '키마스터가 잠겨 있어 보내지 못함' }
  if (r.status !== 200 || !r.json.ok) throw new Error(`앱이 거절함: ${r.status} ${r.json.error ?? ''}`)
  return { found, sent: found, added: r.json.added, updated: r.json.updated, skipped: r.json.skipped }
}
