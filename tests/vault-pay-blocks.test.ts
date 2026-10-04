// 결제 수단 블록 — 계정 없는 결제 비밀번호·카드 항목을 여러 계정에 끼우는 기능.
//
// 지키는 것: (1) 연결은 id·순서만 담고 비밀값은 어디로도 복사되지 않는다 (2) 계정 자신의 항목이 항상 먼저다
// (3) 지원하지 않는 소싱처×수단은 끼울 수 없다 (4) 블록이 지워지면 연결도 사라진다

process.env.VAULT_KDF_MEM = '8192'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { openDatabase, type Db } from '../src/main/db/client'
import { VaultService } from '../src/main/vault/service'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings'
import {
  MAX_PAY_BLOCKS_PER_ACCOUNT,
  PAYMENT_PROVIDER_FIELD_KEY,
  payBlockKindOf,
  paySupportStatusOf,
  type PaymentProvider
} from '../src/shared/vault'

function makeSettings(): { get: () => Settings } {
  const value: Settings = { ...DEFAULT_SETTINGS }
  return { get: () => value }
}

describe('결제 수단 블록', () => {
  let db: Db
  let vault: VaultService
  let musinsa1: number
  let musinsa2: number
  let abc: number

  beforeEach(async () => {
    db = await openDatabase(':memory:')
    vault = new VaultService(db, makeSettings())
    await vault.setup('master-pw')
    musinsa1 = vault.upsertAccount({
      host: 'member.one.musinsa.com',
      label: 'alice',
      username: 'alice',
      isDefault: true
    }).id
    musinsa2 = vault.upsertAccount({
      host: 'member.one.musinsa.com',
      label: 'bob',
      username: 'bob',
      isDefault: false
    }).id
    abc = vault.upsertAccount({
      host: 'abcmart.a-rt.com',
      label: 'abc',
      username: 'abc',
      isDefault: true
    }).id
  })

  afterEach(() => {
    vault.dispose()
    db.close()
  })

  /** 전역(계정 없는) 결제 비밀번호 블록 */
  function addPayBlock(label: string, value: string, provider: PaymentProvider): number {
    return vault.putItem({
      accountId: null,
      type: 'password',
      label,
      sections: [
        {
          key: 'main',
          label: '결제',
          fields: [
            {
              key: PAYMENT_PROVIDER_FIELD_KEY,
              label: '결제 수단',
              kind: 'select',
              value: provider
            },
            { key: 'value', label: '비밀번호', kind: 'secret', value }
          ]
        }
      ]
    }).id
  }

  /** 전역 카드 블록 */
  function addCardBlock(label: string, number: string): number {
    return vault.putItem({
      accountId: null,
      type: 'card',
      label,
      sections: [
        {
          key: 'main',
          label: '카드',
          fields: [{ key: 'number', label: '번호', kind: 'secret', value: number }]
        }
      ]
    }).id
  }

  it('블록 목록은 전역 결제 비밀번호·카드만 담고 비밀값은 어디에도 없다', () => {
    addPayBlock('토스페이 본인', 'SECRET-TOSS-1', 'toss')
    addCardBlock('본인 카드', '4111111111111111')
    vault.putItem({ accountId: null, type: 'note', label: '메모', sections: [] })
    const state = vault.payBlocksState()
    expect(state.blocks.map((b) => b.kind).sort()).toEqual(['card', 'toss'])
    const json = JSON.stringify(state)
    expect(json).not.toContain('SECRET-TOSS-1')
    expect(json).not.toContain('4111111111111111')
  })

  it('끼운 결제 비밀번호 블록이 그 계정의 결제 조회에 잡히고, 다른 계정에는 영향이 없다', () => {
    const block = addPayBlock('토스페이 본인', '335577', 'toss')
    expect(vault.linkPayBlock(musinsa1, block)).toBe(true)
    // 검증 전에는 존재만 보이고 값 채우기는 거절한다
    expect(
      vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value
    ).toBeNull()
    vault.setPaySupport('musinsa.com', 'toss', 'verified')
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value).toBe(
      '335577'
    )
    expect(vault.hasPaymentItem(musinsa1, 'toss')).toBe(true)
    expect(vault.hasPaymentItem(musinsa2, 'toss')).toBe(false)
    // 목록용 메타: 종류 배지와 결제 제공자에도 나타난다
    const listed = vault.listAccounts().find((a) => a.id === musinsa1)
    expect(listed?.itemTypes).toContain('password')
    expect(listed?.paymentProviders).toContain('toss')
    expect(
      vault.listAccounts().find((a) => a.id === musinsa2)?.paymentProviders ?? []
    ).not.toContain('toss')
  })

  it('같은 블록을 여러 계정에 끼워도 원본 하나를 가리킨다(값을 고치면 모두 따라간다)', () => {
    const block = addPayBlock('토스페이 본인', '335577', 'toss')
    vault.linkPayBlock(musinsa1, block)
    vault.linkPayBlock(musinsa2, block)
    vault.setPaySupport('musinsa.com', 'toss', 'verified')
    vault.putItem({
      id: block,
      accountId: null,
      type: 'password',
      label: '토스페이 본인',
      sections: [
        {
          key: 'main',
          label: '결제',
          fields: [
            { key: PAYMENT_PROVIDER_FIELD_KEY, label: '결제 수단', kind: 'select', value: 'toss' },
            { key: 'value', label: '비밀번호', kind: 'secret', value: '000111' }
          ]
        }
      ]
    })
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value).toBe(
      '000111'
    )
    expect(vault.getPaymentSecretForFill({ accountId: musinsa2, provider: 'toss' }).value).toBe(
      '000111'
    )
  })

  it('계정 자신의 항목이 끼운 블록보다 먼저다', () => {
    const block = addPayBlock('토스페이 블록', '111111', 'toss')
    vault.linkPayBlock(musinsa1, block)
    vault.putItem({
      accountId: musinsa1,
      type: 'password',
      label: '토스페이 직접',
      sections: [
        {
          key: 'main',
          label: '결제',
          fields: [
            { key: PAYMENT_PROVIDER_FIELD_KEY, label: '결제 수단', kind: 'select', value: 'toss' },
            { key: 'value', label: '비밀번호', kind: 'secret', value: '222222' }
          ]
        }
      ]
    })
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value).toBe(
      '222222'
    )
  })

  it('같은 수단 블록이 둘이면 연결 순서가 앞선 것이 쓰이고, 순서를 바꾸면 따라 바뀐다', () => {
    const mine = addPayBlock('토스 본인', '111111', 'toss')
    const corp = addPayBlock('토스 법인', '222222', 'toss')
    vault.linkPayBlock(musinsa1, mine)
    vault.linkPayBlock(musinsa1, corp)
    vault.setPaySupport('musinsa.com', 'toss', 'verified')
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value).toBe(
      '111111'
    )
    vault.reorderPayLinks(musinsa1, [corp, mine])
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value).toBe(
      '222222'
    )
  })

  it('끼운 카드 블록은 카드 값 채우기에 쓰이고, 계정 자신의 카드가 있으면 그것이 먼저다', () => {
    const card = addCardBlock('본인 카드', '4111111111111111')
    vault.linkPayBlock(musinsa1, card)
    expect(vault.getSecretForFill(musinsa1, 'card', 'number')).toBeNull() // 검증 전
    vault.setPaySupport('musinsa.com', 'card', 'verified')
    expect(vault.getSecretForFill(musinsa1, 'card', 'number')).toBe('4111111111111111')
    expect(vault.getSecretForFill(musinsa2, 'card', 'number')).toBeNull()
    vault.putItem({
      accountId: musinsa1,
      type: 'card',
      label: '직접 카드',
      sections: [
        {
          key: 'main',
          label: '카드',
          fields: [{ key: 'number', label: '번호', kind: 'secret', value: '5555' }]
        }
      ]
    })
    expect(vault.getSecretForFill(musinsa1, 'card', 'number')).toBe('5555')
  })

  it('지원하지 않는 소싱처×수단은 끼울 수 없고, 미지원으로 바꾸면 이미 끼운 것은 풀린다', () => {
    const toss = addPayBlock('토스페이', '335577', 'toss')
    const siteKey = vault.paySiteKeyOfAccount(musinsa1)
    expect(siteKey).toBe('musinsa.com')
    // 기본은 '미검증' — 막지 않는다
    expect(vault.linkPayBlock(musinsa1, toss)).toBe(true)
    expect(vault.linkPayBlock(musinsa2, toss)).toBe(true)
    // ABC마트는 토스페이 미지원으로 표시 → 거절
    vault.setPaySupport('a-rt.com', 'toss', 'unsupported')
    expect(() => vault.linkPayBlock(abc, toss)).toThrow('unsupported')
    // 무신사도 미지원으로 바꾸면 두 계정의 연결이 모두 풀린다
    expect(vault.setPaySupport('musinsa.com', 'toss', 'unsupported')).toBe(2)
    expect(vault.hasPaymentItem(musinsa1, 'toss')).toBe(false)
    expect(vault.hasPaymentItem(musinsa2, 'toss')).toBe(false)
  })

  it('지원 상태는 저장되고, 검증됨으로 올리면 시각이 남는다', () => {
    vault.setPaySupport('musinsa.com', 'site', 'verified')
    const state = vault.payBlocksState()
    expect(paySupportStatusOf(state.support, 'musinsa.com', 'site')).toBe('verified')
    expect(paySupportStatusOf(state.support, 'musinsa.com', 'kakao')).toBe('unverified')
    expect(state.support.find((s) => s.kind === 'site')?.verifiedAt).not.toBeNull()
    vault.setPaySupport('musinsa.com', 'site', 'unverified')
    expect(vault.payBlocksState().support.find((s) => s.kind === 'site')?.verifiedAt).toBeNull()
  })

  it('한 계정에 끼울 수 있는 수를 넘기면 거절하고, 같은 블록을 두 번 끼우면 false 다', () => {
    const first = addPayBlock('블록0', '000000', 'site')
    expect(vault.linkPayBlock(musinsa1, first)).toBe(true)
    expect(vault.linkPayBlock(musinsa1, first)).toBe(false)
    const kinds: PaymentProvider[] = ['toss', 'kakao', 'naver', 'payco', 'musinsapay']
    for (const k of kinds) vault.linkPayBlock(musinsa1, addPayBlock(`블록-${k}`, '123456', k))
    expect(MAX_PAY_BLOCKS_PER_ACCOUNT).toBe(6)
    expect(() => vault.linkPayBlock(musinsa1, addCardBlock('카드', '4111'))).toThrow('full')
  })

  it('블록을 지우면 연결도 사라지고, 계정 항목이나 없는 계정·블록은 끼울 수 없다', () => {
    const block = addPayBlock('토스페이', '335577', 'toss')
    vault.linkPayBlock(musinsa1, block)
    vault.deleteItem(block)
    expect(vault.payBlocksState().links).toEqual([])
    expect(vault.hasPaymentItem(musinsa1, 'toss')).toBe(false)

    const own = vault.putItem({
      accountId: musinsa1,
      type: 'password',
      label: '직접',
      sections: [
        {
          key: 'main',
          label: '결제',
          fields: [{ key: 'value', label: '비밀번호', kind: 'secret', value: '1' }]
        }
      ]
    }).id
    expect(() => vault.linkPayBlock(musinsa1, own)).toThrow('block-not-found')
    expect(() => vault.linkPayBlock(9999, own)).toThrow('account-not-found')
  })

  it('잠긴 금고에서는 모든 블록 작업이 던진다', () => {
    const block = addPayBlock('토스페이', '335577', 'toss')
    vault.lock()
    expect(() => vault.payBlocksState()).toThrow()
    expect(() => vault.linkPayBlock(musinsa1, block)).toThrow()
    expect(() => vault.unlinkPayBlock(musinsa1, block)).toThrow()
    expect(() => vault.reorderPayLinks(musinsa1, [block])).toThrow()
    expect(() => vault.setPaySupport('musinsa.com', 'toss', 'verified')).toThrow()
  })

  it('항목 종류와 제공자 필드로 블록 종류를 정한다', () => {
    expect(payBlockKindOf('card', [])).toBe('card')
    expect(payBlockKindOf('password', [])).toBe('site')
    expect(payBlockKindOf('login', [])).toBeNull()
    expect(
      payBlockKindOf('password', [
        {
          key: 'main',
          label: '결제',
          fields: [{ key: PAYMENT_PROVIDER_FIELD_KEY, value: 'naver' }]
        }
      ])
    ).toBe('naver')
  })

  it('계정에 직접 저장하면 끼운 공유 블록은 건드리지 않고 그 계정 전용 항목이 새로 생긴다', () => {
    const block = addPayBlock('토스페이 공유', '111111', 'toss')
    vault.linkPayBlock(musinsa1, block)
    vault.linkPayBlock(musinsa2, block)
    vault.setPaySupport('musinsa.com', 'toss', 'verified')
    vault.putItem({
      accountId: musinsa1,
      type: 'password',
      label: '토스페이 직접',
      sections: [
        {
          key: 'main',
          label: '결제',
          fields: [
            { key: PAYMENT_PROVIDER_FIELD_KEY, label: '결제 수단', kind: 'select', value: 'toss' },
            { key: 'value', label: '비밀번호', kind: 'secret', value: '999999' }
          ]
        }
      ]
    })
    // musinsa1 은 전용 값, musinsa2 는 공유 블록 값이 그대로다
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value).toBe(
      '999999'
    )
    expect(vault.getPaymentSecretForFill({ accountId: musinsa2, provider: 'toss' }).value).toBe(
      '111111'
    )
  })

  it('카드는 한 장에서만 읽는다 — 필드마다 다른 카드로 넘어가지 않는다', () => {
    vault.setPaySupport('musinsa.com', 'card', 'verified')
    // 계정 자신의 카드(번호만) + 끼운 카드(번호·CVC)
    vault.putItem({
      accountId: musinsa1,
      type: 'card',
      label: '직접 카드',
      sections: [
        {
          key: 'main',
          label: '카드',
          fields: [{ key: 'number', label: '번호', kind: 'secret', value: '1111' }]
        }
      ]
    })
    const linked = vault.putItem({
      accountId: null,
      type: 'card',
      label: '블록 카드',
      sections: [
        {
          key: 'main',
          label: '카드',
          fields: [
            { key: 'number', label: '번호', kind: 'secret', value: '2222' },
            { key: 'cvc', label: 'CVC', kind: 'secret', value: '999' }
          ]
        }
      ]
    }).id
    vault.linkPayBlock(musinsa1, linked)
    expect(vault.getSecretForFill(musinsa1, 'card', 'number')).toBe('1111')
    expect(vault.getSecretForFill(musinsa1, 'card', 'cvc')).toBeNull() // 블록 카드의 CVC 를 섞지 않는다
    // 계정 카드가 없고 끼운 카드만 둘이면 첫 장에서 모든 필드를 읽는다
    const second = vault.putItem({
      accountId: null,
      type: 'card',
      label: '블록 카드2',
      sections: [
        {
          key: 'main',
          label: '카드',
          fields: [{ key: 'number', label: '번호', kind: 'secret', value: '3333' }]
        }
      ]
    }).id
    vault.linkPayBlock(musinsa2, second)
    vault.linkPayBlock(musinsa2, linked)
    expect(vault.getSecretForFill(musinsa2, 'card', 'number')).toBe('3333')
    expect(vault.getSecretForFill(musinsa2, 'card', 'cvc')).toBeNull()
  })

  it('미검증으로 되돌리면 이미 끼운 블록도 값 채우기에서 빠진다(존재 표시는 남는다)', () => {
    const block = addPayBlock('토스페이', '335577', 'toss')
    vault.linkPayBlock(musinsa1, block)
    vault.setPaySupport('musinsa.com', 'toss', 'verified')
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value).toBe(
      '335577'
    )
    vault.setPaySupport('musinsa.com', 'toss', 'unverified')
    expect(
      vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'toss' }).value
    ).toBeNull()
    expect(vault.hasPaymentItem(musinsa1, 'toss')).toBe(true)
    expect(vault.listAccounts().find((a) => a.id === musinsa1)?.paymentProviders).toContain('toss')
  })

  it('결제 수단을 지정하지 않은 조회는 미검증 블록이 있어도 모호함으로 거절한다(남은 하나를 고르지 않는다)', () => {
    vault.putItem({
      accountId: musinsa1,
      type: 'password',
      label: '무신사머니',
      sections: [
        {
          key: 'main',
          label: '결제',
          fields: [
            { key: PAYMENT_PROVIDER_FIELD_KEY, label: '결제 수단', kind: 'select', value: 'site' },
            { key: 'value', label: '비밀번호', kind: 'secret', value: '149072' }
          ]
        }
      ]
    })
    const toss = addPayBlock('토스페이', '335577', 'toss')
    vault.linkPayBlock(musinsa1, toss) // 미검증
    const r = vault.getPaymentSecretForFill({ accountId: musinsa1 })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('ambiguous')
    // 수단을 지정하면 계정 자신의 항목은 그대로 나온다
    expect(vault.getPaymentSecretForFill({ accountId: musinsa1, provider: 'site' }).value).toBe(
      '149072'
    )
  })

  it('복사는 계정 자신의 항목만 옮기고, 끼운 블록은 복사본이 되어 검증 제한을 벗어나지 못한다', () => {
    const toss = addPayBlock('토스페이', '335577', 'toss')
    vault.linkPayBlock(musinsa1, toss) // 미검증
    expect(vault.copyPaymentItems(musinsa1, musinsa2)).toBe(0)
    expect(vault.hasPaymentItem(musinsa2, 'toss')).toBe(false)
    expect(
      vault.getPaymentSecretForFill({ accountId: musinsa2, provider: 'toss' }).value
    ).toBeNull()
  })

  it('지원 상태는 허용값만 받고, 잘못된 값은 기존 상태를 건드리지 않고 던진다', () => {
    vault.setPaySupport('musinsa.com', 'toss', 'unsupported')
    expect(() => vault.setPaySupport('musinsa.com', 'toss', 'invalid')).toThrow('invalid')
    expect(() => vault.setPaySupport('musinsa.com', 'nope' as 'toss', 'verified')).toThrow(
      'invalid'
    )
    expect(() => vault.setPaySupport('  ', 'toss', 'verified')).toThrow('invalid')
    const state = vault.payBlocksState()
    expect(paySupportStatusOf(state.support, 'musinsa.com', 'toss')).toBe('unsupported')
    expect(state.support.length).toBe(1)
  })

  it('연결 표가 없으면 끼우기·순서 변경은 조용히 넘어가지 않고 던진다', () => {
    const block = addPayBlock('토스페이', '335577', 'toss')
    vault.linkPayBlock(musinsa1, block)
    db.drizzle.run(sql`DROP TABLE pay_block_links`)
    expect(() => vault.reorderPayLinks(musinsa1, [block])).toThrow()
    expect(() => vault.linkPayBlock(musinsa2, block)).toThrow()
    // 읽기는 빈 값으로 본다 — 결제 조회가 표 하나 때문에 통째로 깨지지 않는다
    expect(vault.hasPaymentItem(musinsa1, 'toss')).toBe(false)
    expect(vault.payBlocksState().links).toEqual([])
  })
})
