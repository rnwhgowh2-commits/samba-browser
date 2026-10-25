process.env.VAULT_KDF_MEM = '8192'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { VaultRepo } from '../src/main/vault/repo'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import { loginSourceOf } from '../src/main/vault/login-link'

let db: Db
let vault: VaultService
let settings: Settings
const input = {
  url: 'https://www.lemouton.co.kr/myshop/order/list.html',
  siteName: '르무통 공식몰',
  sourceHost: 'naver.com',
  sourceAccountLabel: '구매계정'
}
beforeEach(async () => {
  db = await openDatabase(':memory:')
  settings = { ...DEFAULT_SETTINGS }
  vault = new VaultService(db, { get: () => settings })
  await vault.setup('test-master')
  const a = vault.upsertAccount({ host: 'naver.com', username: 'buyer', label: '구매계정' })
  vault.putItem({ accountId: a.id, type: 'login', label: '로그인', value: 'first-password' })
})
afterEach(() => {
  vault.dispose()
  db.close()
})

describe('사이트 계정 등록·연결', () => {
  it('기존 비밀번호 연결을 네이버 SSO로 바꾸고 비밀번호 채움을 차단한다', () => {
    const a = vault.registerSiteAccount(input)
    const updated = vault.registerSiteAccount({ ...input, loginMethod: 'naver' })
    expect(updated.id).toBe(a.id)
    expect(vault.loginMethod(a.id)).toBe('naver')
    expect(vault.naverLoginSource(a.id)?.label).toBe('구매계정')
    expect(vault.getSecretForFill(a.id, 'login')).toBeNull()
    expect(vault.hasSameSecret(a.host, a.username, 'first-password')).toBe(false)
    expect(vault.getSecretForFill(vault.listAccounts('naver.com')[0].id, 'login')).toBe(
      'first-password'
    )
    expect(vault.listItems(a.id)).toHaveLength(1)
    const source = vault.listAccounts('naver.com')[0]
    vault.upsertAccount({ ...source, agentAccess: 'never' })
    expect(vault.naverLoginSource(a.id)).toBeNull()
  })
  it('네이버 SSO는 저장 비밀번호가 없어도 연결하며 다른 제공자는 거절한다', () => {
    const source = vault.upsertAccount({
      host: 'nid.naver.com',
      username: 'session',
      label: '세션용'
    })
    const a = vault.registerSiteAccount({
      ...input,
      sourceAccountLabel: source.label,
      loginMethod: 'naver'
    })
    expect(vault.naverLoginSource(a.id)?.id).toBe(source.id)
    expect(vault.getSecretForFill(a.id, 'login')).toBeNull()
    vault.deleteAccounts([source.id])
    expect(vault.naverLoginSource(a.id)).toBeNull()
    vault.upsertAccount({ host: 'other.example', username: 'other', label: '타사' })
    expect(() =>
      vault.registerSiteAccount({
        ...input,
        sourceHost: 'other.example',
        sourceAccountLabel: '타사',
        loginMethod: 'naver'
      })
    ).toThrow('naver-source-required')
  })
  it('수동 로그인에서 같은 값을 인식하고, 사이트만 바뀌면 원본을 보존하며 연결을 되돌린다', () => {
    const a = vault.registerSiteAccount(input)
    expect(vault.hasSameSecret(a.host, a.username, 'first-password')).toBe(true)
    expect(vault.hasSameSecret(a.host, a.username, 'different')).toBe(false)
    const changed = vault.applyAutoPasswordUpdate({
      accountId: a.id,
      username: a.username,
      value: 'site-only-password'
    })
    expect(vault.getSecretForFill(a.id, 'login')).toBe('site-only-password')
    expect(loginSourceOf(new VaultRepo(db).findItemRow(a.id, 'login')!.sections)).toBeNull()
    expect(vault.getSecretForFill(vault.listAccounts('naver.com')[0].id, 'login')).toBe(
      'first-password'
    )
    expect(vault.undoAutoPasswordUpdate(changed.undoToken)).toBe(true)
    expect(vault.getSecretForFill(a.id, 'login')).toBe('first-password')
    expect(loginSourceOf(new VaultRepo(db).findItemRow(a.id, 'login')!.sections)).not.toBeNull()
  })
  it('원본 암호를 복제하지 않고 실제 키마스터 로그인 항목으로 연결한다', () => {
    const a = vault.registerSiteAccount(input)
    expect(a.host).toBe('lemouton.co.kr')
    expect(a.username).toBe('buyer')
    expect(a.itemTypes).toContain('login')
    const item = new VaultRepo(db).findItemRow(a.id, 'login')!
    expect(loginSourceOf(item.sections)).toEqual({ host: 'naver.com', username: 'buyer' })
    expect(item.sections.flatMap((s) => s.fields).some((f) => f.kind === 'secret')).toBe(false)
    expect(JSON.stringify(vault.listItems(a.id))).not.toContain('first-password')
    expect(vault.getSecretForFill(a.id, 'login')).toBe('first-password')
    expect(vault.getSecretForFill(a.id, 'password')).toBeNull()
  })
  it('원본 비밀번호가 바뀌면 연결 계정도 최신 값을 쓰며 중복 등록은 기존 정책을 보존한다', () => {
    const a = vault.registerSiteAccount(input)
    vault.upsertAccount({
      ...a,
      isDefault: true,
      agentAccess: 'while_unlocked',
      tags: ['기존태그']
    })
    const source = vault.listAccounts('naver.com')[0]
    vault.putItem({ accountId: source.id, type: 'login', label: '로그인', value: 'new-password' })
    const again = vault.registerSiteAccount(input)
    expect(again.id).toBe(a.id)
    expect(again.agentAccess).toBe('while_unlocked')
    expect(again.tags).toEqual(['기존태그'])
    expect(again.isDefault).toBe(true)
    expect(vault.listItems(a.id)).toHaveLength(1)
    expect(vault.getSecretForFill(a.id, 'login')).toBe('new-password')
  })
  it('원본 접근 거부·제외·삭제 뒤에는 연결을 사용하지 않는다', () => {
    const a = vault.registerSiteAccount(input)
    const source = vault.listAccounts('naver.com')[0]
    vault.upsertAccount({ ...source, agentAccess: 'never' })
    expect(vault.getSecretForFill(a.id, 'login')).toBeNull()
    vault.upsertAccount({ ...source, agentAccess: 'inherit' })
    settings.vaultExcludedHosts = ['naver.com']
    expect(vault.getSecretForFill(a.id, 'login')).toBeNull()
    settings.vaultExcludedHosts = []
    vault.deleteAccounts([source.id])
    expect(vault.getSecretForFill(a.id, 'login')).toBeNull()
  })
  it('기존 사이트 비밀번호와 다른 원본 연결은 덮어쓰지 않는다', () => {
    const own = vault.upsertAccount({ host: 'lemouton.co.kr', username: 'buyer' })
    vault.putItem({
      accountId: own.id,
      type: 'login',
      label: '원래 비밀번호',
      value: 'own-password'
    })
    expect(() => vault.registerSiteAccount(input)).toThrow('target-login-already-exists')
    expect(vault.getSecretForFill(own.id, 'login')).toBe('own-password')
  })
  it('모호한 원본·연결의 연결·동일 사이트·불안전 URL·잠긴 금고를 거부한다', () => {
    expect(() => vault.registerSiteAccount({ ...input, sourceAccountLabel: '없음' })).toThrow()
    const linked = vault.registerSiteAccount(input)
    expect(() =>
      vault.registerSiteAccount({
        ...input,
        url: 'https://other.example/',
        sourceHost: linked.host,
        sourceAccountLabel: linked.label
      })
    ).toThrow('source-needs-own-login-password')
    expect(() => vault.registerSiteAccount({ ...input, url: 'https://nid.naver.com/' })).toThrow()
    expect(() => vault.registerSiteAccount({ ...input, url: 'http://lemouton.co.kr/' })).toThrow()
    expect(() =>
      vault.registerSiteAccount({ ...input, url: 'https://name:pass@lemouton.co.kr/' })
    ).toThrow()
    vault.lock()
    expect(() => vault.registerSiteAccount(input)).toThrow()
  })
  it('로그인 비밀번호 없이 세션용 계정을 등록할 수 있고 URL의 쿼리는 저장하지 않는다', () => {
    const a = vault.registerSiteAccount({
      url: `${input.url}?token=private#section`,
      siteName: input.siteName,
      username: 'session-user'
    })
    expect(a.itemTypes).toEqual([])
    expect(a.urls).toEqual([input.url])
    expect(vault.getSecretForFill(a.id, 'login')).toBeNull()
  })
  it('다른 작업공간의 같은 아이디 계정을 변경하거나 연결하지 않는다', () => {
    vault.setWorkspaceScope({ id: 2, isDefault: false })
    expect(() => vault.registerSiteAccount(input)).toThrow('source-account-missing-or-ambiguous')
    const a = vault.registerSiteAccount({
      url: input.url,
      siteName: input.siteName,
      username: 'buyer'
    })
    vault.setWorkspaceScope({ id: 3, isDefault: false })
    const b = vault.registerSiteAccount({
      url: input.url,
      siteName: input.siteName,
      username: 'buyer'
    })
    expect(b.id).not.toBe(a.id)
    expect(vault.listAccounts('lemouton.co.kr').map((x) => x.id)).toEqual([b.id])
  })
})
