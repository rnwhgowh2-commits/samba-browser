import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { useVaultStore } from '@renderer/stores/vaultStore'
import { Button } from '@renderer/components/ui/button'
import { ItemEditor } from '@renderer/components/vault/ItemEditor'
import {
  MAX_PAY_BLOCKS_PER_ACCOUNT,
  SELECTABLE_PAYMENT_PROVIDERS,
  paySupportStatusOf
} from '@shared/vault'
import { accountGroupKey } from '@shared/host'
import type {
  AccountDto,
  PayBlockDto,
  PayBlockKind,
  PayBlocksState,
  PaySupportStatus,
  VaultItemMeta,
  VaultItemType
} from '@shared/ipc'

// 설정 > 결제. 결제 수단 블록(카드·페이)을 계정의 칸에 끌어다 끼운다.
// 비밀값은 이 화면에 오지 않는다 — 블록은 id·라벨·종류만, 연결은 id 와 순서만 오간다.
// 카드는 어느 소싱처에든 놓을 수 있고, 페이류는 소싱처가 지원할 때만 놓을 수 있다(지원 표는 사용자가 고친다)

const KINDS: PayBlockKind[] = ['card', ...SELECTABLE_PAYMENT_PROVIDERS.filter((p) => p !== 'other')]

// 지원 칩을 누를 때 도는 순서
const NEXT_STATUS: Record<PaySupportStatus, PaySupportStatus> = {
  unverified: 'verified',
  verified: 'unsupported',
  unsupported: 'unverified'
}

const BLOCK_TONE: Record<'card' | 'pay' | 'site', string> = {
  card: 'border-[rgba(0,122,255,.55)] bg-[rgba(0,122,255,.1)] text-[#0a5cc4]',
  pay: 'border-[rgba(52,199,89,.6)] bg-[rgba(52,199,89,.12)] text-[#1c7a38]',
  site: 'border-[var(--line)] bg-[var(--bg)] text-[var(--text2)]'
}

function toneOf(kind: PayBlockKind): 'card' | 'pay' | 'site' {
  if (kind === 'card') return 'card'
  return kind === 'site' ? 'site' : 'pay'
}

interface DragState {
  itemId: number
  // 이미 끼워진 블록을 끌었으면 그 계정, 트레이에서 끌었으면 null
  from: number | null
}

interface EditorState {
  open: boolean
  key: number
  type: VaultItemType
  item?: VaultItemMeta
}

export function PayBlocksSection(): React.JSX.Element {
  const { t } = useTranslation()
  const vaultState = useVaultStore((s) => s.state)
  const accounts = useVaultStore((s) => s.accounts)
  const loadAccounts = useVaultStore((s) => s.loadAccounts)
  const loadItems = useVaultStore((s) => s.loadItems)
  const refreshState = useVaultStore((s) => s.refreshState)
  const [data, setData] = useState<PayBlocksState | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [overSlot, setOverSlot] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>({ open: false, key: 0, type: 'card' })
  const drag = useRef<DragState | null>(null)
  // 한 번에 하나의 변경만 처리한다 — 연타·겹친 드롭이 오래된 화면 상태로 계산되지 않게
  const busy = useRef(false)

  const reload = useCallback(async (): Promise<void> => {
    const r = await window.samba.vault.payBlocks()
    setData(r.ok ? r.data : null)
  }, [])

  // 자동 잠금·수동 잠금이 이 화면에도 바로 반영되게 금고 상태 변경을 듣는다
  useEffect(() => window.samba.vault.onStateChanged(() => void refreshState()), [refreshState])

  useEffect(() => {
    if (vaultState !== 'unlocked') return
    void loadAccounts()
    let alive = true
    void window.samba.vault.payBlocks().then((r) => {
      if (alive) setData(r.ok ? r.data : null)
    })
    return () => {
      alive = false
    }
  }, [vaultState, loadAccounts])

  if (vaultState !== 'unlocked') {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--text2)]">
        {t('payBlocks.locked')}
      </div>
    )
  }

  const kindLabel = (kind: PayBlockKind): string =>
    kind === 'card' ? t('payBlocks.card') : t(`vault.paymentProvider.${kind}`)

  const say = (text: string, error = false): void => setMessage({ text, error })

  const errorText = (raw: string): string => {
    if (raw.includes('unsupported')) return t('payBlocks.msgUnsupported')
    if (raw.includes('full')) return t('payBlocks.msgFull', { max: MAX_PAY_BLOCKS_PER_ACCOUNT })
    return t('payBlocks.msgFail')
  }

  const blockById = new Map((data?.blocks ?? []).map((b) => [b.itemId, b]))
  const linksOf = (accountId: number): PayBlockDto[] =>
    (data?.links ?? [])
      .filter((l) => l.accountId === accountId)
      .sort((a, b) => a.position - b.position)
      .flatMap((l) => {
        const block = blockById.get(l.itemId)
        return block ? [block] : []
      })

  const openEditor = (type: VaultItemType, item?: VaultItemMeta): void =>
    setEditor((e) => ({ open: true, key: e.key + 1, type, item }))

  const onEditorOpenChange = (open: boolean): void => {
    setEditor((e) => ({ ...e, open }))
    if (!open) {
      void loadItems(null)
      void reload()
    }
  }

  const editBlock = async (block: PayBlockDto): Promise<void> => {
    const r = await window.samba.vault.items(null)
    const item = r.ok ? r.data.find((i) => i.id === block.itemId) : undefined
    if (item) openEditor(item.type, item)
  }

  // 변경 작업을 한 번에 하나씩만 돌린다(진행 중이면 새 요청은 버린다)
  const exclusive = async (fn: () => Promise<void>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    try {
      await fn()
      await reload()
    } finally {
      busy.current = false
    }
  }

  const drop = async (accountId: number, index: number): Promise<void> => {
    const d = drag.current
    drag.current = null
    setOverSlot(null)
    if (!d) return
    await exclusive(async () => {
      const ids = linksOf(accountId).map((b) => b.itemId)
      if (d.from === accountId) {
        // 같은 계정 안에서 옮기기 — 순서만 바꾼다
        const without = ids.filter((id) => id !== d.itemId)
        without.splice(Math.min(index, without.length), 0, d.itemId)
        const r = await window.samba.vault.payReorder(accountId, without)
        if (!r.ok) say(errorText(r.error), true)
        else say(t('payBlocks.msgReordered'))
        return
      }
      const r = await window.samba.vault.payLink(accountId, d.itemId)
      if (!r.ok) {
        say(errorText(r.error), true)
        return
      }
      if (!r.data) {
        // 이 계정에 이미 있는 블록이다 — 아무것도 옮기지 않았으니 원본도 건드리지 않는다
        say(t('payBlocks.msgAlready'), true)
        return
      }
      // 놓은 칸 위치로 끼운다(연결은 맨 뒤에 생기므로 앞 칸에 놓았으면 순서를 다시 매긴다)
      if (index < ids.length) {
        const order = [...ids]
        order.splice(index, 0, d.itemId)
        const o = await window.samba.vault.payReorder(accountId, order)
        if (!o.ok) {
          say(errorText(o.error), true)
          return
        }
      }
      // 다른 계정에서 끌어왔으면 원본 연결을 푼다 — 실패하면 두 곳에 남은 채라고 알린다
      if (d.from !== null) {
        const u = await window.samba.vault.payUnlink(d.from, d.itemId)
        if (!u.ok) {
          say(errorText(u.error), true)
          return
        }
      }
      say(t('payBlocks.msgLinked'))
    })
  }

  const unlink = async (accountId: number, itemId: number): Promise<void> => {
    await exclusive(async () => {
      const r = await window.samba.vault.payUnlink(accountId, itemId)
      if (!r.ok) say(errorText(r.error), true)
      else say(t('payBlocks.msgUnlinked'))
    })
  }

  const cycleSupport = async (siteKey: string, kind: PayBlockKind): Promise<void> => {
    await exclusive(async () => {
      const current = paySupportStatusOf(data?.support ?? [], siteKey, kind)
      const r = await window.samba.vault.paySupport(siteKey, kind, NEXT_STATUS[current])
      if (!r.ok) {
        say(errorText(r.error), true)
      } else if (r.data > 0) {
        say(t('payBlocks.msgReleased', { count: r.data }))
      }
    })
  }

  // 소싱처(등록 도메인)별 계정 묶음
  const groups = new Map<string, AccountDto[]>()
  for (const a of accounts) {
    const key = accountGroupKey(a.host) || a.host
    groups.set(key, [...(groups.get(key) ?? []), a])
  }
  const siteKeys = [...groups.keys()].sort()

  const statusBadge = (status: PaySupportStatus): React.JSX.Element => (
    <span
      className={
        'rounded-full px-1.5 py-px text-[10px] ' +
        (status === 'verified'
          ? 'bg-[rgba(52,199,89,.15)] text-[#1c7a38]'
          : status === 'unsupported'
            ? 'bg-[rgba(255,59,48,.12)] text-[#ff3b30]'
            : 'bg-[rgba(255,159,10,.15)] text-[#b26a00]')
      }
    >
      {t(`payBlocks.status.${status}`)}
    </span>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 p-6">
        <section className="rounded-xl border border-[var(--line)] bg-white p-4">
          <div className="mb-1 flex items-center gap-2">
            <h3 className="text-[13px] font-semibold">{t('payBlocks.trayTitle')}</h3>
            <div className="ml-auto flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-[26px] rounded-[9px]"
                onClick={() => openEditor('card')}
              >
                {t('payBlocks.addCard')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-[26px] rounded-[9px]"
                onClick={() => openEditor('password')}
              >
                {t('payBlocks.addPay')}
              </Button>
            </div>
          </div>
          <p className="mb-3 text-[11.5px] text-[var(--text3)]">{t('payBlocks.trayHint')}</p>
          <div className="flex flex-wrap gap-2.5">
            {(data?.blocks ?? []).length === 0 && (
              <span className="text-[12px] text-[var(--text3)]">{t('payBlocks.trayEmpty')}</span>
            )}
            {(data?.blocks ?? []).map((block) => (
              <div
                key={block.itemId}
                draggable
                onDragStart={() => {
                  drag.current = { itemId: block.itemId, from: null }
                }}
                onDragEnd={() => {
                  drag.current = null
                  setOverSlot(null)
                }}
                onDoubleClick={() => void editBlock(block)}
                title={t('payBlocks.blockHint')}
                className={`flex h-[92px] w-[92px] cursor-grab select-none flex-col justify-between rounded-md border-[1.5px] p-2 ${BLOCK_TONE[toneOf(block.kind)]}`}
              >
                <span className="text-[12px] font-medium leading-tight">
                  {kindLabel(block.kind)}
                </span>
                <span className="truncate text-[11px] opacity-85">{block.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--line)] bg-white p-4">
          <h3 className="mb-1 text-[13px] font-semibold">{t('payBlocks.accountsTitle')}</h3>
          <p className="mb-3 text-[11.5px] text-[var(--text3)]">{t('payBlocks.accountsHint')}</p>
          {siteKeys.length === 0 && (
            <span className="text-[12px] text-[var(--text3)]">{t('payBlocks.noAccounts')}</span>
          )}
          {siteKeys.map((siteKey) => (
            <div key={siteKey} className="border-t border-black/[.06] py-2 first:border-t-0">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[12.5px] font-medium">{siteKey}</span>
                <span className="text-[11px] text-[var(--text3)]">
                  {t('payBlocks.supportLabel')}
                </span>
                {KINDS.map((kind) => {
                  const status = paySupportStatusOf(data?.support ?? [], siteKey, kind)
                  return (
                    <button
                      key={kind}
                      type="button"
                      title={t('payBlocks.supportHint')}
                      onClick={() => void cycleSupport(siteKey, kind)}
                      className="flex items-center gap-1 rounded-full border border-[var(--line)] px-1.5 py-px text-[11px] text-[var(--text2)]"
                    >
                      {kindLabel(kind)}
                      {statusBadge(status)}
                    </button>
                  )
                })}
              </div>
              {(groups.get(siteKey) ?? []).map((account) => {
                const linked = linksOf(account.id)
                return (
                  <div
                    key={account.id}
                    className="grid grid-cols-[150px_1fr] items-center gap-2 py-1.5"
                  >
                    <span className="truncate text-[12px] text-[var(--text2)]">
                      {account.label}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {linked.map((block, i) => {
                        const status = paySupportStatusOf(data?.support ?? [], siteKey, block.kind)
                        return (
                          <div
                            key={block.itemId}
                            onDragOver={(e) => {
                              e.preventDefault()
                              setOverSlot(`${account.id}:${i}`)
                            }}
                            onDrop={(e) => {
                              e.preventDefault()
                              void drop(account.id, i)
                            }}
                            className="flex items-center gap-1"
                          >
                            <span className="w-3 text-[11px] text-[var(--text3)]">{i + 1}</span>
                            <div
                              draggable
                              onDragStart={() => {
                                drag.current = { itemId: block.itemId, from: account.id }
                              }}
                              onDragEnd={() => {
                                drag.current = null
                                setOverSlot(null)
                              }}
                              className={`relative flex h-[78px] w-[78px] cursor-grab select-none flex-col justify-between rounded-md border-[1.5px] p-1.5 ${BLOCK_TONE[toneOf(block.kind)]}`}
                            >
                              <div className="flex items-start gap-1">
                                <span className="text-[12px] font-medium leading-tight">
                                  {kindLabel(block.kind)}
                                </span>
                                <button
                                  type="button"
                                  aria-label={t('payBlocks.remove')}
                                  onClick={() => void unlink(account.id, block.itemId)}
                                  className="ml-auto text-[12px] opacity-70"
                                >
                                  ×
                                </button>
                              </div>
                              <span className="truncate text-[11px] opacity-85">{block.label}</span>
                              <span className="absolute bottom-1 right-1">
                                {statusBadge(status)}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                      {linked.length < MAX_PAY_BLOCKS_PER_ACCOUNT && (
                        <div
                          onDragOver={(e) => {
                            e.preventDefault()
                            setOverSlot(`${account.id}:end`)
                          }}
                          onDragLeave={() => setOverSlot(null)}
                          onDrop={(e) => {
                            e.preventDefault()
                            void drop(account.id, linked.length)
                          }}
                          className={
                            'flex h-[78px] w-[78px] items-center justify-center rounded-md border-[1.5px] border-dashed text-center text-[11px] ' +
                            (overSlot === `${account.id}:end`
                              ? 'border-[rgba(0,122,255,.6)] bg-[rgba(0,122,255,.08)] text-[#0a5cc4]'
                              : 'border-[var(--line)] text-[var(--text3)]')
                          }
                        >
                          {t('payBlocks.slotHere')}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          {message && (
            <div
              className={
                'mt-2 text-[12px] ' + (message.error ? 'text-[#ff3b30]' : 'text-[var(--text2)]')
              }
            >
              {message.text}
            </div>
          )}
        </section>
      </div>
      <ItemEditor
        key={editor.key}
        open={editor.open}
        onOpenChange={onEditorOpenChange}
        type={editor.type}
        item={editor.item}
      />
    </div>
  )
}
