import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Globe, X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { profileColor, profileTint } from '@renderer/lib/profile-color'
import { useBrowserStore } from '@renderer/stores/browserStore'
import { useUiStore } from '@renderer/stores/uiStore'
import { SiteFavicon } from '@renderer/components/vault/SiteFavicon'
import { groupTabsBySite, tabFaviconHost, tabRowLabel } from './sidebar-view'

/**
 * 사이드바의 "열린 탭" 섹션. 위쪽 TabBar 와 같은 목록(browserStore)을 세로로 보여 준다.
 * 소싱처(무신사·LF몰 …)별로 묶어 보여 주고, 묶음 머리를 누르면 접고 펼친다.
 * 클릭하면 그 탭으로 전환하고 브라우저 뷰로 돌아오며, 호버 시 × 로 닫는다
 */
export function OpenTabs(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useBrowserStore((s) => s.tabs)
  const activateTab = useBrowserStore((s) => s.activateTab)
  const closeTab = useBrowserStore((s) => s.closeTab)
  const setView = useUiStore((s) => s.setView)
  // 접어 둔 묶음(소싱처 이름). 화면에만 있는 상태라 저장하지 않는다
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const otherLabel = t('tab.otherGroup')
  const groups = useMemo(() => groupTabsBySite(tabs, otherLabel), [tabs, otherLabel])

  if (tabs.length === 0)
    return <div className="px-2 py-1 text-[11px] text-[var(--text3)]">{t('tab.empty')}</div>

  return (
    // 탭이 많아도 사이드바가 창보다 길어지지 않게 이 목록만 스크롤한다(최대 화면 높이의 45%)
    <div className="flex min-h-0 max-h-[45vh] flex-col overflow-y-auto">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key)
        const groupHost = group.tabs.map((tab) => tabFaviconHost(tab.url)).find(Boolean) ?? ''
        return (
          <section key={group.key || '__other'} className="mb-1">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(group.key)) next.delete(group.key)
                  else next.add(group.key)
                  return next
                })
              }
              className="flex w-full items-center gap-1.5 rounded-[9px] px-1.5 py-1 text-left text-[11px] font-semibold text-[var(--text2)] hover:bg-black/5"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-[var(--text3)]" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0 text-[var(--text3)]" />
              )}
              {groupHost ? (
                <SiteFavicon host={groupHost} size={13} />
              ) : (
                <Globe className="h-3 w-3 shrink-0 text-[var(--text3)]" />
              )}
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
              <span className="shrink-0 text-[10px] font-normal text-[var(--text3)]">
                {group.tabs.length}
              </span>
            </button>
            {!isCollapsed && (
              <ul className="flex flex-col pl-3">
                {group.tabs.map((tab) => {
                  const label = tabRowLabel(tab, t('tab.untitled'))
                  const host = tabFaviconHost(tab.url)
                  const color = profileColor(tab.profile)
                  return (
                    <li key={tab.id} className="group relative flex items-center">
                      <button
                        type="button"
                        title={label}
                        onClick={() => {
                          void activateTab(tab.id)
                          setView('browser')
                        }}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2 rounded-[9px] px-2 py-1.5 text-left text-[12px] text-[var(--text2)] hover:bg-black/5',
                          tab.active && 'bg-black/5 font-medium text-[var(--text)]'
                        )}
                      >
                        {host ? (
                          <SiteFavicon host={host} size={14} />
                        ) : (
                          <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--text3)]" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {/* 계정별 세션(프로필) 탭 — 탭 바와 같은 색 배지 */}
                        {color && (
                          <span
                            title={t('tab.profileOf', { profile: tab.profileLabel ?? tab.profile })}
                            className="shrink-0 rounded-[5px] px-1 py-px text-[10px]"
                            style={{
                              color,
                              backgroundColor: profileTint(tab.profile) ?? undefined
                            }}
                          >
                            {tab.profileLabel ?? tab.profile}
                          </span>
                        )}
                        {/* 팝업 창(결제창·주소 검색창)은 탭이 아니라는 것을 배지로 구분해 준다 */}
                        {tab.kind === 'popup' && (
                          <span className="shrink-0 rounded-[5px] bg-black/5 px-1 py-px text-[10px] text-[var(--text3)]">
                            {t('tab.popup')}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label={t('tab.close')}
                        title={t('tab.close')}
                        onClick={() => void closeTab(tab.id)}
                        className="absolute right-1 hidden rounded-[7px] p-1 text-[var(--text3)] hover:bg-black/5 hover:text-[var(--text)] group-hover:block"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
