// 기존 MCP 어댑터의 도구 명세에 계정 등록·연결 도구만 추가한다(앱·계정 설정은 변경하지 않는다).
import { copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const path = process.argv[2] ?? join(homedir(), '.samba-browser-mcp', 'tools.json')
const tools = JSON.parse(readFileSync(path, 'utf8'))
const definition = {
  name: 'register_site_account',
  description:
    '현재 사이트를 키마스터에 등록하거나 사용자가 지정한 기존 계정의 로그인에 연결한다. ' +
    'sourceHost와 정확한 sourceAccountLabel을 함께 주면 연결한다. loginMethod=naver는 현재 프로필의 네이버 세션으로 간편로그인하며 비밀번호를 공유하지 않는다. shared_password는 명시적으로 같은 비밀번호를 쓰는 경우에만 사용한다. ' +
    '그 외에는 username으로 세션용 계정을 등록한다. 현재 로그인 탭·쿠키를 바꾸지 않는다. ' +
    '사이트 회원가입이나 구매·취소 접수를 실행하는 기능이 아니며, 비밀번호는 받거나 반환하지 않는다.',
  inputSchema: {
    type: 'object',
    properties: {
      siteName: { type: 'string', minLength: 1, maxLength: 120 },
      username: { type: 'string', minLength: 1, maxLength: 254 },
      label: { type: 'string', minLength: 1, maxLength: 120 },
      sourceHost: { type: 'string', minLength: 1, maxLength: 254 },
      sourceAccountLabel: { type: 'string', minLength: 1, maxLength: 254 },
      loginMethod: { type: 'string', enum: ['shared_password', 'naver'] }
    },
    required: ['siteName'],
    additionalProperties: false
  }
}
const index = tools.findIndex((t) => t.name === definition.name)
if (index >= 0) tools[index] = definition
else tools.push(definition)
copyFileSync(path, `${path}.bak-account-${Date.now()}`)
writeFileSync(`${path}.account.tmp`, JSON.stringify(tools, null, 2) + '\n', 'utf8')
renameSync(`${path}.account.tmp`, path)
console.log('MCP 계정 등록·연결 도구 명세 반영 완료')
