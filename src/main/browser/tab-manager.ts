import {
  app,
  BrowserWindow,
  WebContentsView,
  safeStorage,
  session,
  type Input,
  type Session,
  type WebContents
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { enableExtensionServiceWorkerSupport } from '../extensions/cookies-bridge'
import type { ExtensionTabsProvider } from '../extensions/tabs-bridge'
import { randomUUID } from 'crypto'
import { IPC, type Layout, type TabInfo } from '../../shared/ipc'
import type { ClosedTabRecord } from './gestures'
import {
  BLOCKED_URL_MESSAGE,
  isAllowedUrl,
  isExtensionUrl,
  isInternalUrl,
  NEW_TAB_URL
} from '../../shared/url'
import { normalizeHost } from '../../shared/host'
import { attachInternalProtocol } from './internal-protocol'
import type { PermissionMode, SearchEngine } from '../../shared/settings'
import { applyMobileEmulation, clearMobileEmulation, MOBILE_WIDTH } from './emulation'
import { installWebstoreNavigatorUserAgent, installWebstoreUserAgent } from './webstore-ua'
import { installSessionCookieKeeper } from './session-cookies'
import { setCookieClearTarget } from './cookie-clear'
import {
  createProfileLabelReader,
  parseSitesAccountLabels,
  parseSitesProfileSites,
  parseSitesWorkspace
} from './profile-labels'
import {
  cookieSnapshotReady,
  installCookieSnapshot,
  legacySnapshotFileName,
  snapshotFileName
} from './session-cookie-snapshot'
import { installDialogHandler, isAutomationActive } from './dialogs'
import {
  isAutomation,
  isHumanInputEvent,
  lastHumanInWindowAt,
  markHuman,
  markHumanInWindow
} from './human-activity'
import {
  isHumanMouseInput,
  openInBackground,
  pickWorkingTabId,
  shouldHoldVisible
} from './visible-guard'
import { PopupRegistry, type PopupEntry } from './popups'
import {
  DISCARD_IDLE_MS,
  DISCARDED_PAGE_URL,
  discardableProbe,
  discardableUrl,
  hotLaneIds,
  LANE_DISCARD_ENABLED,
  PAGE_KEEP_PROBE_JS,
  splitBehind,
  stackOrder
} from './behind-views'
import { buildTargets, pickAgentTargetId, type AgentTarget } from './targets'
import { getFaviconService, type FaviconResponse } from '../favicon/service'
import { nextZoomLevel, zoomKeyAction, type ZoomAction } from './zoom'
import { HealGate, paintDiag, shortId, stackMismatch, topTabId } from './paint-diag'

// 보이는 탭이 맨 위가 아닌 층 어긋남을 확인하는 주기
const STACK_CHECK_MS = 5000
// 비워 둔 탭을 다시 열 때 도구 호출이 기다리는 최대 시간 — 부하가 높으면 새 렌더러가 수십 초 늦게 뜬다(도구 제한 90초 안)
const RESTORE_WAIT_MS = 45_000
// 페이지를 비우기 전 페이지 안 확인(누른 적·입력 중)의 제한 시간
const DISCARD_PROBE_MS = 3000
// 다시 연 페이지의 첫 화면을 기다리는 최대 시간과 그 확인 스크립트(두 프레임 지나면 끝)
const FIRST_PAINT_WAIT_MS = 1500
const FIRST_PAINT_JS = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))'

export interface Tab {
  id: string
  view: WebContentsView
  profile: string
  mobile: boolean
  // 이 탭을 window.open 으로 띄운 탭. 결제창처럼 별도 WebContents 로 열리는 팝업을
  // 부모 탭에서 다시 찾기 위해 남긴다(결제 성공 리다이렉트 확인에 쓴다)
  openerId?: string
  // 열 때 요청한 주소. 페이지가 아직 안 떠서 현재 주소가 비어 있을 때 사이드바가 소싱처를 알아보는 데 쓴다
  openUrl?: string
  // 이 탭이 쓰는 세션 파티션('persist:ws2-musinsa-1'). 자동화 레인 탭은 현재 작업공간과 무관하게 고정 작업공간을 쓴다
  partition?: string
  // 지금 주소에 맞는 웹스토어 UA 를 다시 거는 함수(모바일 모드 해제 뒤 호출)
  refreshWebstoreUa?: () => void
  // 메모리를 아끼려고 페이지를 비워 둔 레인 탭의 원래 주소·제목(discardIdleLane). 다시 쓰면 restoreTab 이 연다
  discarded?: { url: string; title: string }
  // 원래 주소를 다시 여는 중이면 그 약속(whenRestored 가 기다린다)
  restoring?: Promise<void>
  // 비우지 않기로 한 주소(누른 적 있음·입력 중). 주소가 바뀌기 전에는 다시 확인하지 않는다
  keepUrl?: string
}

/**
 * window.open 으로 열린 팝업 창(결제창 등). 크롬처럼 별도 창으로 띄운다.
 * Electron 의 createWindow 는 BrowserWindow 를 기대하므로 WebContentsView 로 만들면 네이티브 크래시가 난다.
 * 탭 목록에는 넣지 않고 따로 추적해(popups.ts), 부모 탭이 결제 결과를 확인할 때 찾는다
 */
type Popup = PopupEntry<BrowserWindow>

// 설정을 아직 못 읽었을 때의 기본 주소. 설정이 들어오면 setDefaultUrl 로 덮인다
const DEFAULT_URL = NEW_TAB_URL

// 렌더러가 보고한 좌표를 "현재" 창 콘텐츠 크기에 다시 투영한다.
// 렌더러는 보고 시점의 뷰포트 크기를 함께 보내므로, 거기서 오른쪽·아래 여백을 뽑아
// 지금 창 크기에 그대로 적용한다. 창 크기가 바뀌는 동안 렌더러의 재보고가
// 늦거나 누락돼도(크기 변경 중 렌더링 파이프라인이 지연되면 실제로 생긴다)
// 웹뷰가 카드 아래·오른쪽으로 삐져나오지 않는다.
// mobile=true 이면 웹뷰를 웨일 모바일 창처럼 가운데 412px 폭 카드로 좁힌다.
// 폭만 좁히고 x 를 다시 계산할 뿐, y·높이는 그대로 둔다(세로는 전체 유지하기로 결정)
export function computeViewBounds(
  l: Layout,
  contentWidth: number,
  contentHeight: number,
  mobile = false
): Layout {
  const empty = { x: 0, y: 0, width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 }
  if (l.width <= 0 || l.height <= 0) return empty
  // 뷰포트 정보가 없는 오래된 보고는 좌표를 그대로 쓴다(하위 호환)
  const gapRight = l.viewportWidth > 0 ? Math.max(0, l.viewportWidth - (l.x + l.width)) : 0
  const gapBottom = l.viewportHeight > 0 ? Math.max(0, l.viewportHeight - (l.y + l.height)) : 0
  const width = l.viewportWidth > 0 ? contentWidth - l.x - gapRight : l.width
  const height = l.viewportHeight > 0 ? contentHeight - l.y - gapBottom : l.height
  if (width <= 0 || height <= 0) return empty
  if (mobile) {
    // "현재" 창 크기로 재투영된 width 를 기준으로 좁힌다(창 크기 변경 중에도 카드가 어긋나지 않게)
    const mobileWidth = Math.min(MOBILE_WIDTH, width)
    const mobileX = l.x + Math.floor((width - mobileWidth) / 2)
    return {
      x: mobileX,
      y: l.y,
      width: mobileWidth,
      height,
      viewportWidth: contentWidth,
      viewportHeight: contentHeight
    }
  }
  return {
    x: l.x,
    y: l.y,
    width,
    height,
    viewportWidth: contentWidth,
    viewportHeight: contentHeight
  }
}

// 프로필 → 계정 이름표(세션 관리자가 앱 데이터 폴더에 적어 둔 profile-labels.json). 파일이 없으면 프로필 이름 그대로
// 세션 관리자 설정(sites.json)의 계정 이름을 탭 옆에 보여 준다. 경로는 처음 쓸 때 읽는다
let profileLabelReader: ((profile: string) => string | undefined) | null = null
function profileLabelOf(profile: string): string | undefined {
  profileLabelReader ??= createProfileLabelReader(
    join(app.getAppPath(), 'tools', 'session-keeper', 'sites.json'),
    parseSitesAccountLabels
  )
  return profileLabelReader(profile)
}
let pinnedWorkspaceReader: ((key: string) => string | undefined) | null = null
/**
 * 자동화 레인 탭이 쓸 파티션 접두사. sites.json 의 workspaceId 가 있으면 'persist:ws<N>-', 없으면 undefined(현재 작업공간).
 * 사용자가 작업공간을 바꿔도 세션 관리자·레인 탭은 로그인이 들어 있는 같은 작업공간을 계속 쓴다(2026-10-24 사고)
 */
function pinnedAutomationPrefix(): string | undefined {
  pinnedWorkspaceReader ??= createProfileLabelReader(
    join(app.getAppPath(), 'tools', 'session-keeper', 'sites.json'),
    parseSitesWorkspace
  )
  const id = pinnedWorkspaceReader('workspaceId')
  return id ? `persist:ws${id}-` : undefined
}
let profileSiteReader: ((profile: string) => string | undefined) | null = null
function profileSiteOf(profile: string): string | undefined {
  profileSiteReader ??= createProfileLabelReader(
    join(app.getAppPath(), 'tools', 'session-keeper', 'sites.json'),
    parseSitesProfileSites
  )
  return profileSiteReader(profile)
}

// 이미 하드닝한 파티션 이름. session.fromPartition 은 같은 인스턴스를 돌려주므로 1회만 건다
const hardenedPartitions = new Set<string>()

// 세션 기본 거부 정책: 권한 요청·권한 조회·다운로드를 모두 막는다(1단계 범위)
function hardenSession(ses: Session, partition: string): void {
  if (hardenedPartitions.has(partition)) return
  hardenedPartitions.add(partition)
  // 페이지 preload 는 세션에 등록한다. 탭의 webPreferences.preload 는 window.open 으로 만들어진
  // 팝업(결제창 등) webContents 에는 적용되지 않아 계정 선택기·AI 스냅샷이 빠졌었다.
  // 모든 프레임에서 돌지만 page.ts 가 최상위 문서에서만 설치한다
  ses.registerPreloadScript({ type: 'frame', filePath: join(__dirname, '../preload/page.js') })
  // 확장 백그라운드(서비스워커)에 없는 chrome.cookies 를 보충한다 — 없으면 삼바웨이브·ADPICK 백그라운드가 죽었다
  enableExtensionServiceWorkerSupport(ses, join(__dirname, '../preload/extension-sw.js'))
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn(`권한 요청 거부: ${permission}`)
    callback(false)
  })
  ses.setPermissionCheckHandler((_wc, permission) => {
    console.warn(`권한 조회 거부: ${permission}`)
    return false
  })
  ses.on('will-download', (e, item) => {
    e.preventDefault()
    console.warn(`다운로드 차단: ${item.getURL()}`)
  })
  // 웹스토어는 Electron UA 를 보면 "지원되지 않는 브라우저" 안내로 설치 버튼을 감춘다.
  // 그 호스트 요청에만 크롬 UA 를 보낸다(다른 사이트는 그대로)
  installWebstoreUserAgent(ses)
  // 로그인 토큰이 세션 쿠키인 사이트(무신사)는 앱을 다시 켤 때마다 반쪽 로그인이 됐다 —
  // 크롬의 "이전 세션 이어서" 처럼 세션 쿠키에 만료를 얹어 남긴다
  installSessionCookieKeeper(ses)
  // 로그인 토큰이 host-only 세션 쿠키인 사이트(LF몰·더현대 …)는 앱을 다시 켜면 로그아웃됐다 —
  // 실행 중에는 암호화 파일에 모아 두고, 다음 시작 때 한 번만 되살린다
  installSnapshot(ses, partition)
}

// 암호화 파일(safeStorage)에 보관·복원. 암호화를 못 쓰면 아무것도 저장하지 않는다
function installSnapshot(ses: Session, partition: string): void {
  const dir = join(app.getPath('userData'), 'session-cookies')
  const filePath = join(dir, snapshotFileName(partition))
  const legacy = legacySnapshotFileName(partition)
  const legacyPath = legacy ? join(dir, legacy) : null
  installCookieSnapshot(
    ses,
    {
      read: () => {
        if (!safeStorage.isEncryptionAvailable()) return null
        // 새 이름 파일이 없으면 옛 이름 파일(영문 이름만)을 한 번 이어받는다
        const src = existsSync(filePath) ? filePath : legacyPath && existsSync(legacyPath) ? legacyPath : null
        return src ? safeStorage.decryptString(readFileSync(src)) : null
      },
      write: (text) => {
        if (!safeStorage.isEncryptionAvailable()) return false
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, safeStorage.encryptString(text))
        return true
      }
    },
    // 값은 남기지 않는다 — 어느 단계가 실패했는지만
    { onError: (what) => console.warn(`로그인 쿠키 보관 실패: ${what}`) }
  )
}

// 리다이렉트·페이지 내 이동으로 금지 스킴에 도달하는 경로까지 막는다.
// allowExtension 은 확장 문서(옵션 페이지)를 담은 탭에만 준다 — 그 탭 안에서는
// `chrome-extension://` 사이 이동이 정상이기 때문이다(웹 페이지 탭에는 주지 않는다)
export function guardNavigation(wc: WebContents, allowExtension: boolean): void {
  const allowed = (url: string): boolean =>
    isAllowedUrl(url) || (allowExtension && isExtensionUrl(url))
  wc.on('will-navigate', (e, url) => {
    if (allowed(url)) return
    e.preventDefault()
    console.warn(`이동 차단: ${url}`)
  })
  wc.on('will-redirect', (e, url) => {
    if (allowed(url)) return
    e.preventDefault()
    console.warn(`리다이렉트 차단: ${url}`)
  })
}

// 탭 = WebContentsView 1개. 프로필은 persist: 파티션으로 쿠키 분리
/**
 * 탭의 웹 내용이 아직 살아 있는가.
 * WebContentsView 가 닫히면 `view.webContents` 자체가 undefined 가 된다 — 곧바로 isDestroyed() 를 부르면
 * "Cannot read properties of undefined" 로 메인 프로세스가 죽는다(실기: 탭 이벤트가 닫힌 탭 목록을 돌 때)
 */
export function isTabAlive(tab: {
  view: { webContents?: { isDestroyed(): boolean } | null }
}): boolean {
  const wc = tab.view.webContents
  return wc !== undefined && wc !== null && !wc.isDestroyed()
}

export class TabManager {
  private tabs: Tab[] = []
  private popups = new PopupRegistry<BrowserWindow>()
  private activeId: string | null = null
  // AI 가 switch_tab 으로 고른 팝업. 그 팝업이 닫히면 계산 단계에서 자동으로 무시된다
  private focusedPopupId: string | null = null
  // 자동화 대상 탭 — 사람이 이 창을 쓰는 중이라 자동화가 보이는 탭을 바꾸지 못했을 때, 자동화가 고른 탭을
  // 여기에만 적어 둔다(visible-guard.ts). 화면은 사람이 보던 탭 그대로이고 AI 도구는 이 탭을 조작한다.
  // null 이면 보이는 탭이 곧 자동화 대상이다
  private automationTabId: string | null = null
  // 보이는 탭 아래 층(contentView z-order 맨 아래)에 붙여 둔 뒤 탭 — 자동화 대상·레인 탭(behind-views.ts).
  // 창에 붙지 않은 뷰는 뷰포트가 0 이라 스냅샷·레이아웃이 어긋나므로, 뒤에서 조작하는 탭도 창에 붙여 둔다
  private behindIds: string[] = []
  // 레인(lane-tabs)이 연 탭 — 전역 자동화 대상이 아니어도 뒤 층에 붙여 둔다
  private laneIds = new Set<string>()
  // 레인 탭을 마지막으로 쓴 시각과 진행 중인 도구 호출이 붙잡은 레인 탭 집합 — 쉬는 레인 탭은 뒤 층에서 떼어
  // 그리지 않게 한다(hotLaneIds)
  private laneTouchedAt = new Map<string, number>()
  private laneHolds = new Map<symbol, ReadonlySet<string>>()
  // 페이지 비우기 확인이 진행 중이면 다음 점검은 건너뛴다(한 번에 한 탭)
  private discarding = false
  // 팝업이 새로 열렸을 때 알리는 구독자(AI 도구가 "팝업이 열렸다"를 결과에 붙인다)
  private popupOpenedListeners: Array<(target: AgentTarget) => void> = []
  // 로그인 게이트: 계정 로그인 전에는 탭 뷰(네이티브)를 화면에서 치운다 — 렌더러가 가리는 것만으로는 안 보인다
  private gateHidden = false
  // withFront 가 다른 탭을 잠깐 맨 위로 올려 둔 동안은 층 점검이 어긋남으로 보지 않는다
  private frontDepth = 0
  // 층 어긋남 자동 복구 횟수 제한과 점검 타이머(paint-diag.ts)
  private healGate = new HealGate()
  private stackTimer: ReturnType<typeof setInterval> | null = null
  private layout: Layout = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    viewportWidth: 0,
    viewportHeight: 0
  }
  private listeners: Array<(tabs: TabInfo[]) => void> = []
  // 탭 전환 구독자(확장 액션 팝업을 닫는다)
  private activatedListeners: Array<() => void> = []
  // 방문 구독자(활동 기록). **호스트 한 조각만** 넘긴다 — 전체 URL·검색어는 넘기지 않는다
  private visitListeners: Array<(host: string) => void> = []
  private disposed = false
  // === 홈 버튼 / 설정 페이지 (신규 추가분) ==================================
  // url 없이 탭을 생성할 때 쓸 기본 주소(설정의 홈 주소/새 탭 주소로부터 계산되어 들어온다)
  private defaultUrl = DEFAULT_URL
  // 주소창 검색어 → URL 변환에 쓸 기본 검색엔진
  private searchEngine: SearchEngine = 'google'
  // 탭 세션 파티션 접두사. 작업공간이 바뀌면 handlers 가 갈아 끼운다.
  // 이미 열려 있는 탭의 세션은 건드리지 않고, 새로 여는 탭부터 새 파티션을 쓴다
  private partitionPrefix = 'persist:'
  // 이 창이 실제로 만든 파티션 세션. 새 파티션이 생기면 확장 관리자에게 알려 준다
  private partitionSessions = new Map<string, Session>()
  private sessionHook: ((ses: Session, partition: string) => void) | null = null
  // 탭 우클릭 메뉴 설치 훅(번역 메뉴). 주입하지 않으면 메뉴를 붙이지 않는다
  private contextMenuHook: ((wc: WebContents) => void) | null = null
  // 창 안에서만 듣는 키 입력 처리기(작업공간 Ctrl+Alt+1~9). true 를 돌려주면 페이지로 넘기지 않는다
  private inputHandler: ((input: Input) => boolean) | null = null
  // === 신규 추가분 끝 ========================================================
  // AI 작업이 실행 중인지 알려 주는 판정기(handlers 가 AgentRunner 를 연결한다).
  // 페이지 JS 대화상자는 작업 실행 중에만 자동 처리한다
  private agentRunning: () => boolean = () => false
  // 대화상자 처리 정책(사용 권한 모드 + 사용자 확인 수단). handlers 가 연결한다
  private dialogMode: () => PermissionMode = () => 'guard'
  private dialogConfirm: ((message: string) => Promise<boolean>) | undefined
  // 자동 처리한 대화상자 문구(탭별 1건). 다음 도구 결과 앞에 붙이고 비운다
  private lastDialogMessage = new Map<string, string>()
  // === 마우스 제스처 ========================================================
  // 페이지 preload 에 밀어 줄 제스처 설정(켜짐 여부·언어·매핑). 설정이 바뀌면 handlers 가 갈아 끼운다
  private gestureConfig: unknown = null
  // 탭이 닫힐 때 알리는 구독자(닫은 탭 다시 열기 스택)
  private closedListeners: Array<(tab: ClosedTabRecord) => void> = []
  // === 마우스 제스처 끝 ======================================================

  constructor(private win: BrowserWindow) {
    // 쿠키 삭제 입구(브릿지 /cookies/clear)가 이 탭 관리자의 세션을 찾는다
    setCookieClearTarget(this)
    // 창이 닫히면 남은 리스너·탭을 정리해 파괴된 창에 접근하지 않게 한다
    win.once('closed', () => this.dispose())
    // 창 크기가 바뀌면 렌더러 보고를 기다리지 않고 메인이 먼저 맞춘다.
    // (최대화·복원·드래그 리사이즈 때 렌더러 보고가 누락되면 이전 크기가 그대로 남아
    //  웹페이지가 카드 밖까지 그려지던 문제를 막는다)
    win.on('resize', () => this.applyBounds())
    // 최대화·복원은 resize 가 중간 크기로 한 번 먼저 오고 최종 크기가 나중에 확정되므로
    // 끝난 뒤에 한 번 더 맞춘다
    win.on('maximize', () => this.applyBounds())
    win.on('unmaximize', () => this.applyBounds())
    // 보이는 탭이 다른 탭 뒤로 밀려 흰 화면만 보이는 상태를 찾아 바로잡는다
    // 같은 타이머로 한동안 안 쓴 레인 탭을 뒤 층에서 뗀다
    this.stackTimer = setInterval(() => {
      this.sleepIdleLanes()
      this.discardIdleLane()
      this.checkStack()
    }, STACK_CHECK_MS)
    this.stackTimer.unref()
  }

  onChange(cb: (tabs: TabInfo[]) => void): void {
    this.listeners.push(cb)
  }

  /**
   * 탭이 활성화될 때 알린다(확장 액션 팝업 닫기).
   * onChange 와 나눠 둔 이유는 onChange 가 로딩·제목 변경에도 매번 불리기 때문이다
   */
  onActivated(cb: () => void): void {
    this.activatedListeners.push(cb)
  }

  /**
   * 활성 탭이 어떤 사이트를 보고 있는지 알린다(활동 기록).
   * 넘기는 값은 정규화된 **호스트 문자열 하나**뿐이다. 내부 페이지·빈 페이지는 알리지 않는다
   */
  onVisit(cb: (host: string) => void): void {
    this.visitListeners.push(cb)
  }

  /** 주소에서 호스트만 뽑아 구독자에게 알린다 */
  private noteVisit(url: string): void {
    if (this.visitListeners.length === 0) return
    if (!/^https?:\/\//i.test(url)) return
    const host = normalizeHost(url)
    if (host === '') return
    for (const cb of this.visitListeners) cb(host)
  }

  // === 홈 버튼 / 설정 페이지 (신규 추가분) ==================================
  // handlers.ts 가 설정 로드/변경 시 호출한다. tab-manager 는 newTabUrl·homeUrl
  // 조합 로직을 모르고, 이미 계산된 최종 URL 문자열만 받는다
  setDefaultUrl(url: string): void {
    this.defaultUrl = url
  }

  setSearchEngine(engine: SearchEngine): void {
    this.searchEngine = engine
  }

  /**
   * 탭 세션 파티션 접두사를 바꾼다(작업공간 전환).
   * 열려 있는 탭은 그대로 두고 새 탭부터 적용된다 — 진행 중인 로그인 세션을 끊지 않기 위해서다
   */
  setPartitionPrefix(prefix: string): void {
    this.partitionPrefix = prefix
  }

  /**
   * 파티션 세션이 처음 만들어질 때 호출될 처리기를 연결한다(확장 재로드용).
   * 이미 만들어 둔 세션에는 곧바로 한 번씩 적용한다
   */
  setSessionHook(fn: (ses: Session, partition: string) => void): void {
    this.sessionHook = fn
    for (const [partition, ses] of this.partitionSessions) fn(ses, partition)
  }

  /** 탭 우클릭 메뉴 설치 훅을 연결한다. 이미 열려 있는 탭에도 소급 적용한다 */
  setContextMenuHook(fn: (wc: WebContents) => void): void {
    this.contextMenuHook = fn
    for (const tab of this.tabs) fn(tab.view.webContents)
  }

  /**
   * 창 안에서만 동작하는 키 입력 처리기를 연결한다(작업공간 전환 단축키).
   * 처리기가 true 를 돌려주면 그 입력은 페이지로 전달되지 않는다
   */
  setInputHandler(fn: (input: Input) => boolean): void {
    this.inputHandler = fn
    // 이미 열려 있는 탭에도 소급 적용한다
    for (const tab of this.tabs) this.attachInputHandler(tab.view.webContents)
  }

  private attachInputHandler(wc: WebContents): void {
    wc.on('before-input-event', (e, input) => {
      if (this.inputHandler?.(input)) e.preventDefault()
    })
  }

  // === 확대·축소 ============================================================
  // 메뉴를 숨겨 둔 창에서는 Ctrl+± / Ctrl+휠이 저절로 동작하지 않아 직접 처리한다.
  // 배율은 Chromium 이 호스트별로 세션에 기억한다(사이트마다 따로, 크롬과 같다)
  private attachZoom(wc: WebContents): void {
    wc.on('before-input-event', (e, input) => {
      const action = zoomKeyAction(input)
      if (!action) return
      e.preventDefault()
      this.applyZoom(wc, action)
    })
    // Ctrl+휠 — 기본 동작이 막혀 있어 'zoom-changed' 로 방향만 받는다
    wc.on('zoom-changed', (_e, direction) => this.applyZoom(wc, direction))
  }

  private applyZoom(wc: WebContents, action: ZoomAction): void {
    if (wc.isDestroyed()) return
    wc.setZoomLevel(nextZoomLevel(wc.getZoomLevel(), action))
  }

  /** 렌더러(사이드바 등)에 포커스가 있을 때 누른 Ctrl+± 도 보이는 탭에 적용한다 */
  zoomActive(action: ZoomAction): void {
    const tab = this.active()
    if (tab) this.applyZoom(tab.view.webContents, action)
  }

  // === 마우스 제스처 ========================================================
  /**
   * 페이지 preload 에 밀어 줄 제스처 설정을 갈아 끼운다.
   * 이미 열려 있는 탭에도 즉시 반영한다(설정 화면에서 끄면 바로 궤적이 사라지도록)
   */
  setGestureConfig(config: unknown): void {
    this.gestureConfig = config
    for (const tab of this.tabs) this.sendGestureConfig(tab.view.webContents)
  }

  private sendGestureConfig(wc: WebContents): void {
    if (this.gestureConfig === null || wc.isDestroyed()) return
    wc.send(IPC.pageGestureConfig, this.gestureConfig)
  }

  /** 탭이 닫힐 때(다시 열기 스택에 쌓을 수 있게) 알린다 */
  onTabClosed(cb: (tab: ClosedTabRecord) => void): void {
    this.closedListeners.push(cb)
  }

  /**
   * 페이지를 맨 위·맨 아래로 보낸다(제스처 ↑/↓).
   * 페이지가 window.scrollTo 를 덮어썼어도 영향을 받지 않도록 격리 월드에서 실행한다
   */
  async scrollTo(id: string, to: 'top' | 'bottom'): Promise<void> {
    const tab = this.get(id)
    if (!tab) return
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    const top = to === 'top' ? '0' : 'el.scrollHeight'
    // preload 가 사는 격리 월드 id(Electron WorldId.ISOLATED_WORLD). page-bridge 와 같은 값이지만
    // 순환 import 를 만들지 않으려고 여기서는 숫자를 직접 쓴다
    await wc.executeJavaScriptInIsolatedWorld(999, [
      {
        code: `(() => { const el = document.scrollingElement || document.documentElement; el.scrollTo({ top: ${top}, behavior: 'smooth' }); return '' })()`
      }
    ])
  }
  // === 마우스 제스처 끝 ======================================================

  /** AI 작업 실행 여부 판정기를 연결한다(대화상자 자동 처리 조건) */
  setAgentRunningProvider(fn: () => boolean): void {
    this.agentRunning = fn
  }

  /**
   * 페이지 대화상자 처리 정책을 연결한다.
   * guard 모드의 confirm/beforeunload 는 confirm 으로 사용자 승인을 받는다
   */
  setDialogPolicy(policy: {
    mode: () => PermissionMode
    confirm?: (message: string) => Promise<boolean>
  }): void {
    this.dialogMode = policy.mode
    this.dialogConfirm = policy.confirm
  }

  /**
   * 자동 처리한 대화상자 문구를 한 번 꺼내고 비운다.
   * tabId 를 생략하면 활성 탭 기준이다(도구 결과에 붙일 때 쓴다)
   */
  takeDialogMessage(tabId?: string): string | null {
    const id = tabId ?? this.activeId
    if (!id) return null
    const message = this.lastDialogMessage.get(id)
    if (message === undefined) return null
    this.lastDialogMessage.delete(id)
    return message
  }
  // === 신규 추가분 끝 ========================================================

  private emit(): void {
    if (this.disposed) return
    // 팝업까지 함께 보낸다 — 사이드바가 결제창·주소 검색창을 "팝업" 배지로 보여 준다
    const list = this.listAll()
    for (const cb of this.listeners) cb(list)
  }

  // 창이 사라진 뒤 호출되는 늦은 이벤트를 무시하기 위한 정리
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.stackTimer !== null) clearInterval(this.stackTimer)
    this.stackTimer = null
    this.listeners = []
    this.activatedListeners = []
    this.closedListeners = []
    this.popupOpenedListeners = []
    this.tabs = []
    this.activeId = null
    this.automationTabId = null
    this.behindIds = []
    this.laneIds.clear()
    this.laneTouchedAt.clear()
    this.laneHolds.clear()
    this.focusedPopupId = null
    // 부모 창이 사라졌는데 결제창만 남아 떠 있지 않게 팝업도 함께 파괴한다
    this.popups.destroyAll()
  }

  list(): TabInfo[] {
    return this.tabs
      .filter((t) => isTabAlive(t))
      .map((t) => ({
        id: t.id,
        // 비워 둔 탭은 원래 주소·제목을 보여 준다(사이드바 소싱처 묶음·세션 관리자 탭 목록이 그대로 보이게)
        url: t.discarded?.url ?? (t.view.webContents.getURL() || t.openUrl || ''),
        title: t.discarded?.title ?? t.view.webContents.getTitle(),
        profile: t.profile,
        ...(profileLabelOf(t.profile) ? { profileLabel: profileLabelOf(t.profile) } : {}),
        ...(profileSiteOf(t.profile) ? { profileSite: profileSiteOf(t.profile) } : {}),
        mobile: t.mobile,
        loading: t.discarded ? false : t.view.webContents.isLoading(),
        active: t.id === this.activeId
      }))
  }

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  get(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  /** 쿠키 삭제용: 프로필의 세션. automation 이면 자동화 레인이 쓰는 고정 작업공간 쪽(없으면 현재 작업공간) */
  sessionFor(profile: string, automation: boolean): Session {
    const prefix = automation ? (pinnedAutomationPrefix() ?? this.partitionPrefix) : this.partitionPrefix
    const partition = `${prefix}${profile}`
    return this.partitionSessions.get(partition) ?? session.fromPartition(partition)
  }

  /** 프로필의 세션(탭과 같은 파티션). 아직 탭을 연 적 없는 프로필이어도 같은 저장소를 쓴다 */
  sessionForProfile(profile: string): Session {
    const partition = `${this.partitionPrefix}${profile}`
    return this.partitionSessions.get(partition) ?? session.fromPartition(partition)
  }

  /** 이 세션을 쓰는 프로필 이름. 탭 파티션이 아니면(기본 세션) 'default' */
  profileOfSession(ses: Session): string {
    for (const [partition, s] of this.partitionSessions) {
      if (s === ses && partition.startsWith(this.partitionPrefix)) return partition.slice(this.partitionPrefix.length)
    }
    return 'default'
  }

  /** 확장 탭·창 API 다리(extensions/tabs-bridge)에 줄 탭 관리 기능 */
  extensionTabsProvider(): ExtensionTabsProvider {
    const byWc = (wc: WebContents): Tab | undefined => this.tabs.find((t) => t.view.webContents === wc)
    return {
      tabs: () =>
        this.tabs
          .filter((t) => isTabAlive(t))
          .map((t) => ({
            wc: t.view.webContents,
            active: t.id === this.activeId,
            profile: t.profile,
            ...(t.discarded ? { shown: t.discarded } : {})
          })),
      create: (url, profile, active) => {
        // 뒤에서 열기 — 크롬 tabs.create({active:false}) 처럼 보던 탭을 그대로 둔다
        const info = this.create({ url, profile, background: !active && this.activeId !== null })
        return this.get(info.id)?.view.webContents ?? null
      },
      close: (wc) => {
        const t = byWc(wc)
        if (t) this.close(t.id)
      },
      activate: (wc) => {
        const t = byWc(wc)
        if (t) this.activate(t.id)
      },
      profileOf: (ses) => this.profileOfSession(ses)
    }
  }

  // IPC 발신자가 실제로 관리 중인 탭의 webContents 인지 확인(위조 발신자 방지, vault:capture 검증용)
  hasWebContents(wc: WebContents): boolean {
    return this.tabs.some((t) => t.view.webContents === wc)
  }

  // IPC 발신자에 해당하는 탭(새 탭 페이지가 자기 탭을 이동시킬 때 쓴다)
  findByWebContents(wc: WebContents): Tab | null {
    const tab = this.tabs.find((t) => t.view.webContents === wc)
    if (tab) return tab
    const popup = this.popups.find((p) => p.win.webContents === wc)
    return popup ? this.asTab(popup) : null
  }

  /**
   * 팝업 창을 탭 모양으로 감싼다 — 소비자는 .view.webContents 와 .view.getBounds() 만 쓴다.
   * getBounds 는 화면 캡처·OCR 이 대상 크기를 알아야 해서 함께 채운다. 팝업은 창 전체가
   * 곧 페이지라 원점은 (0,0) 이다(탭 뷰 좌표와 같은 의미로 맞춘다)
   */
  private asTab(p: Popup): Tab {
    const win = p.win
    const view = {
      webContents: win.webContents,
      getBounds: (): { x: number; y: number; width: number; height: number } => {
        if (win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
        const [width, height] = win.getContentSize()
        return { x: 0, y: 0, width, height }
      }
    }
    return {
      id: p.id,
      view: view as unknown as WebContentsView,
      profile: p.profile,
      mobile: false,
      openerId: p.openerId
    }
  }

  // === AI 작업 대상(탭 + 팝업) ==============================================

  /** 탭과 살아 있는 팝업을 한 목록으로. AI 의 list_tabs 와 사이드바 목록이 같이 쓴다 */
  listTargets(): AgentTarget[] {
    const tabs = this.list().map((t) => ({ id: t.id, title: t.title, url: t.url }))
    const popups = this.popups.alive().map((p) => ({
      id: p.id,
      title: p.win.isDestroyed() ? '' : p.win.webContents.getTitle(),
      url: p.win.isDestroyed() ? '' : p.win.webContents.getURL(),
      openerId: p.openerId
    }))
    // AI 가 보는 '활성' 표시는 자동화 대상 탭 기준이다(보이는 탭과 다를 수 있다)
    return buildTargets(tabs, popups, this.workingTabId(), this.focusedPopupId)
  }

  /**
   * 렌더러(탭 바·사이드바)가 보는 목록. 탭 뒤에 살아 있는 팝업을 kind 'popup' 으로 붙인다.
   * 팝업은 active 를 언제나 false 로 둔다 — 렌더러의 "활성 탭"(주소창·뒤로가기 대상)은
   * 언제나 진짜 탭이어야 하기 때문이다
   */
  listAll(): TabInfo[] {
    const popups: TabInfo[] = this.popups.alive().map((p) => ({
      id: p.id,
      url: p.win.isDestroyed() ? '' : p.win.webContents.getURL(),
      title: p.win.isDestroyed() ? '' : p.win.webContents.getTitle(),
      profile: p.profile,
      mobile: false,
      loading: p.win.isDestroyed() ? false : p.win.webContents.isLoading(),
      active: false,
      kind: 'popup'
    }))
    return [...this.list().map((t) => ({ ...t, kind: 'tab' as const })), ...popups]
  }

  /** id 로 팝업을 찾는다(살아 있는 것만) */
  /** id 로 탭 또는 살아 있는 팝업(Tab 모양). 레인 보기(lane-tabs)가 제 작업 창을 돌려줄 때 쓴다 */
  targetTab(id: string): Tab | null {
    const popup = this.popupById(id)
    if (popup && !popup.win.isDestroyed()) return this.asTab(popup)
    return this.get(id)
  }

  private popupById(id: string): Popup | null {
    return this.popups.find((p) => p.id === id)
  }

  /**
   * AI 가 지금 조작할 대상. focusTarget 으로 고른 팝업이 살아 있으면 그 팝업,
   * 아니면 활성 탭이다 — 결제창이 닫히면 자동으로 원래 탭으로 돌아온다
   */
  agentTarget(): Tab | null {
    const alive = this.popups.alive()
    const id = pickAgentTargetId(
      this.focusedPopupId,
      alive.map((p) => p.id),
      this.workingTabId()
    )
    if (id === null) return null
    const popup = alive.find((p) => p.id === id)
    if (popup) return this.asTab(popup)
    // 표식이 가리키던 팝업이 닫혔으면 표식을 지워 둔다(다음 호출부터는 계산이 짧아진다)
    this.focusedPopupId = null
    return this.get(id)
  }

  /** AI 작업 대상을 고른다. 탭이면 전환, 팝업이면 그 창에 포커스를 준다 */
  focusTarget(id: string): void {
    const popup = this.popupById(id)
    if (popup) {
      this.focusedPopupId = id
      if (!popup.win.isDestroyed()) {
        if (this.holdVisible()) {
          // 사람이 이 창을 쓰는 중이면 포커스를 가져가지 않는다 — 숨어 있으면 포커스 없이 보여만 준다
          if (!popup.win.isVisible()) popup.win.showInactive()
        } else {
          popup.win.show()
          popup.win.focus()
        }
      }
      this.emit()
      return
    }
    this.focusedPopupId = null
    this.activate(id)
  }

  /** 대상을 닫는다. 팝업이면 창을 닫고, 탭이면 기존 close 와 같다 */
  closeTarget(id: string): void {
    const popup = this.popupById(id)
    if (!popup) {
      this.close(id)
      return
    }
    if (this.focusedPopupId === id) this.focusedPopupId = null
    if (!popup.win.isDestroyed()) popup.win.close()
    this.emit()
  }

  /** 팝업이 새로 열릴 때 알림을 받는다. 해제 함수를 돌려준다 */
  onPopupOpened(cb: (target: AgentTarget) => void): () => void {
    this.popupOpenedListeners.push(cb)
    return () => {
      this.popupOpenedListeners = this.popupOpenedListeners.filter((f) => f !== cb)
    }
  }

  /**
   * 이 탭이 띄운 팝업 중 아직 살아 있는 가장 최근 것.
   * 간편결제처럼 결제창이 별도 WebContents 로 열리는 사이트에서 성공 리다이렉트를 확인할 때 쓴다
   */
  popupOf(openerId: string): Tab | null {
    const popup = this.popups.latestFor(openerId)
    if (popup) return this.asTab(popup)
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      const t = this.tabs[i]
      if (t.openerId === openerId && isTabAlive(t)) return t
    }
    return null
  }

  create(
    opts: {
      url?: string
      profile?: string
      mobile?: boolean
      openerId?: string
      /**
       * 확장 문서(옵션 페이지) 탭인가. 앱이 스스로 여는 경로(툴바 액션)에서만 켠다 —
       * 주소창 입력·웹페이지의 window.open·AI 도구는 이 값을 주지 않으므로
       * `chrome-extension://` 은 그쪽으로는 여전히 열리지 않는다
       */
      extension?: boolean
      /** 보이는 탭을 바꾸지 않고 뒤에서 연다(자동화 대상 표식도 건드리지 않는다) */
      background?: boolean
      /**
       * 전역 자동화 대상 표식을 건드리지 않는다 — 레인(lane-tabs)은 제 작업 창을 따로 쥐므로
       * 레인 탭 생성이 레인 없는 세션의 대상 탭을 바꾸면 안 된다
       */
      keepAgentTarget?: boolean
    } = {}
  ): TabInfo {
    if (this.disposed) throw new Error('window closed')
    // url 이 없으면(새 탭 버튼·첫 탭) 설정에서 계산된 기본 주소를 쓴다
    const url = opts.url ? opts.url : this.defaultUrl
    const allowExtension = opts.extension === true
    // 탭 생성 경로(주소창·AI new_tab·페이지의 window.open)의 공통 관문
    if (!isAllowedUrl(url) && !(allowExtension && isExtensionUrl(url))) {
      throw new Error(`${BLOCKED_URL_MESSAGE} (${url})`)
    }
    const profile = opts.profile ?? 'default'
    // 레인 탭(세션 관리자·MCP 레인)은 고정 작업공간, 사람이 연 탭은 현재 작업공간
    const prefix = opts.keepAgentTarget === true ? (pinnedAutomationPrefix() ?? this.partitionPrefix) : this.partitionPrefix
    const partition = `${prefix}${profile}`
    const ses = session.fromPartition(partition)
    hardenSession(ses, partition)
    // 파티션 세션에도 samba:// 핸들러를 붙인다(기본 세션 등록만으로는 탭에서 안 열림)
    attachInternalProtocol(ses)
    // 처음 보는 파티션이면 확장 관리자에게 알려 같은 확장을 이 세션에도 걸게 한다
    if (!this.partitionSessions.has(partition)) {
      this.partitionSessions.set(partition, ses)
      this.sessionHook?.(ses, partition)
    }
    const view = new WebContentsView({
      // preload 는 세션에 등록돼 있다(hardenSession) — 여기서 또 주면 두 번 실행된다
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        // iframe(카카오 우편번호·결제 키패드) 안에도 페이지 preload(__samba)가 돌게 한다.
        // 이 값이 없으면 Electron 은 최상위 프레임에서만 preload 를 실행한다
        nodeIntegrationInSubFrames: true,
        // 창이 가려지거나 뒤로 가도 탭이 계속 그려지게 한다 — 키패드 OCR 캡처(capturePage)가
        // "Current display surface not available for capture" 로 실패하던 원인(실기 2026-09-28)
        backgroundThrottling: false
      }
    })
    // WebContentsView 는 네이티브 레이어라 CSS overflow-hidden 으로 잘리지 않는다.
    // setBorderRadius 는 4개 모서리를 한 번에 같은 값으로만 설정할 수 있어(상단만 둥글게 불가),
    // 카드가 상단만 둥글고(rounded-t-2xl) 하단은 창 바닥에 닿는 edge-to-edge 레이아웃에서는
    // 0 으로 둬 하단 사각 모서리와 일치시킨다(상단은 카드 테두리 뒤에 가려져 시각적으로 차이가 적다)
    view.setBorderRadius(0)
    const tab: Tab = {
      id: randomUUID(),
      view,
      profile,
      mobile: opts.mobile ?? false,
      openUrl: url,
      partition,
      ...(opts.openerId === undefined ? {} : { openerId: opts.openerId })
    }
    this.tabs.push(tab)
    const wc = view.webContents
    this.attachInputHandler(wc)
    this.attachZoom(wc)
    this.contextMenuHook?.(wc)
    // 상태 변화 이벤트마다 리스너에 통지 (개별 등록: on() 오버로드가 유니온 리터럴을 받지 않음)
    // 비워 둔 탭이 다른 경로(확장 tabs.update 등)로 새 주소로 가면 그 주소가 최신이다 — 저장해 둔 옛 주소로 되돌리지 않는다
    wc.on('did-start-navigation', (details) => {
      if (!tab.discarded || !details.isMainFrame || details.isSameDocument) return
      if (details.url === DISCARDED_PAGE_URL) return
      tab.discarded = undefined
      this.emit()
    })
    wc.on('did-start-loading', () => this.emit())
    wc.on('did-stop-loading', () => this.emit())
    wc.on('page-title-updated', () => this.emit())
    wc.on('did-navigate', () => {
      // 활성 탭에서 다른 사이트로 옮겨 갔을 때만 방문으로 센다(뒤 탭의 자동 이동은 세지 않는다)
      if (this.activeId === tab.id) this.noteVisit(wc.getURL())
      this.emit()
    })
    // 로드 실패는 원인 파악이 어려우므로 항상 로그로 남긴다(내부 페이지·차단된 주소 진단용)
    // 내부 페이지의 콘솔 오류는 메인 로그로 넘긴다(개발자 도구 없이 진단)
    wc.on('console-message', (ev) => {
      if (ev.level === 'error' && isInternalUrl(wc.getURL())) {
        console.error(`내부 페이지 콘솔: ${ev.message} (${ev.sourceId}:${ev.lineNumber})`)
      }
    })
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (isMainFrame && code !== -3) console.error(`탭 로드 실패 ${code} ${desc}: ${failedUrl}`)
    })
    wc.on('did-navigate-in-page', () => this.emit())
    // 렌더러가 죽거나 멈추면 그 탭이 흰 화면으로 보인다 — 원인을 사후에 알 수 있게 남긴다(paint-diag.ts)
    wc.on('render-process-gone', (_e, details) =>
      paintDiag('render-process-gone', {
        tab: shortId(tab.id),
        reason: details.reason,
        exitCode: details.exitCode,
        active: this.activeId === tab.id
      })
    )
    // 'responsive' 는 평소에도 탭마다 몇 분 간격으로 와서(실측 2시간 235건, 'unresponsive' 는 0건) 멈췄다 풀린 경우만 남긴다
    let hung = false
    wc.on('unresponsive', () => {
      hung = true
      paintDiag('unresponsive', { tab: shortId(tab.id), active: this.activeId === tab.id })
    })
    wc.on('responsive', () => {
      if (!hung) return
      hung = false
      paintDiag('responsive', { tab: shortId(tab.id) })
    })
    // 문서가 바뀔 때마다 제스처 설정을 다시 밀어 준다(preload 는 매 문서마다 새로 뜬다)
    wc.on('dom-ready', () => this.sendGestureConfig(wc))
    // 탭이 실제로 받은 파비콘을 파비콘 서비스 캐시에 넣어 둔다.
    // 이미 열고 있는 페이지에서 나온 정보라 추가로 노출되는 것이 없고,
    // /favicon.ico 가 없는 사이트의 아이콘도 이 경로로 채워진다
    wc.on('page-favicon-updated', (_e, icons) => {
      const iconUrl = icons?.[0]
      if (typeof iconUrl !== 'string') return
      const service = getFaviconService()
      if (!service) return
      // 파비콘은 Node fetch 로 받는다. 탭 세션의 ses.fetch 는 확장(webRequest)이 켜져 있으면 앱을 죽인다
      // (Electron 39 ExtensionApiFrameIdMap::GetDocumentLifecycle null — 크래시 덤프 3건 실측 2026-09-25)
      void service
        .storeFromPage(
          wc.getURL(),
          iconUrl,
          (url, init) => globalThis.fetch(url, init) as unknown as Promise<FaviconResponse>
        )
        .catch((e: unknown) => {
          console.warn('파비콘 저장 실패', e instanceof Error ? e.message : String(e))
        })
    })
    guardNavigation(wc, allowExtension)
    // 웹스토어 페이지 JS 가 읽는 navigator.userAgent 도 헤더와 같은 크롬 UA 로 맞춘다.
    // 모바일 탭은 emulation.ts 가 UA 를 따로 관리하므로 건드리지 않는다
    tab.refreshWebstoreUa = installWebstoreNavigatorUserAgent(wc, () => tab.mobile)
    // 사람의 키 입력·마우스 누름을 기록한다 — 그 탭은 잠시 자동화가 입력·로그인하지 않고,
    // 창 전체도 잠시 자동화가 보이는 탭을 바꾸거나 포커스를 가져가지 않는다(human-activity.ts·visible-guard.ts)
    this.watchHumanInput(wc)
    // 페이지 JS 대화상자(alert/confirm/prompt)는 작업 실행 중 자동으로 닫는다.
    // 작업이 없어도 사람이 보고 있지 않은 탭(백그라운드·레인 탭)의 alert 는 닫는다
    installDialogHandler(wc, {
      // SAMBA_E2E 환경변수는 개발 빌드에서만 인정한다(패키징된 앱에서 자동 처리 금지)
      isAutomationActive: () =>
        isAutomationActive(this.agentRunning(), process.env, !app.isPackaged),
      // 사람이 보는 탭 = 포커스를 가진(최소화되지 않은) 창의 활성 탭. 사람의 클릭은 키 입력 기록
      // (humanBusy)에 남지 않으므로 그것까지 요구하지는 않는다 — 활성 탭의 루프는 반복 감지가 막는다
      isUserFacing: () =>
        this.activeId === tab.id &&
        !this.win.isDestroyed() &&
        this.win.isFocused() &&
        !this.win.isMinimized(),
      mode: () => this.dialogMode(),
      ...(this.dialogConfirm ? { confirm: this.dialogConfirm } : {}),
      onMessage: (message) => this.lastDialogMessage.set(tab.id, message)
    })
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      if (!isAllowedUrl(target)) {
        console.warn(`새 창 차단: ${target}`)
        return { action: 'deny' }
      }
      // 여는 쪽 페이지에 알린다 — 새 탭이 열려도 그 페이지 화면은 그대로라, AI 클릭의 재시도 폴백이
      // 같은 버튼을 다시 눌러 탭이 여러 개 열렸다(실기: SAMBA-WAVE 원문링크 → 탭 4개)
      if (!wc.isDestroyed()) wc.send(IPC.pagePopupOpened)
      // 크롬과 같은 규칙: target=_blank 링크·일반 새 탭 요청은 탭으로 연다.
      // (같은 profile 로 열어 로그인 세션·쿠키가 이어진다)
      if (disposition === 'foreground-tab' || disposition === 'background-tab') {
        try {
          // 보이지 않는 탭(자동화가 뒤에서 조작하는 탭)이 연 새 탭은 사람이 보던 탭을 덮지 않게 뒤에서 연다
          const background = openInBackground(tab.id, this.activeId)
          const opened = this.create({
            url: target,
            profile,
            mobile: tab.mobile,
            openerId: tab.id,
            background
          })
          // 자동화 대상 탭이 연 탭이면 자동화 대상도 새 탭으로 옮긴다(보이는 탭이 연 새 탭을 따라가던 예전 동작과 같다)
          if (background && this.automationTabId === tab.id) this.automationTabId = opened.id
        } catch (e: unknown) {
          console.warn('새 탭 등록 실패', e instanceof Error ? e.message : String(e))
        }
        return { action: 'deny' }
      }
      // 창 크기를 지정한 window.open(결제창·인증창) 은 별도 창으로 띄운다.
      // 'deny' 하고 URL 만 따로 열면 페이지가 받는 window 참조가 null 이 되어,
      // about:blank 팝업을 먼저 열고 폼을 target 으로 보내는 결제 흐름이 통째로 깨진다.
      // 창은 Electron 의 표준 경로에 맡기고(직접 createWindow 로 만들면 부모 탭이 이동하는 순간
      // 브라우저 프로세스가 죽는 경우가 있었다), did-create-window 에서 받아 추적만 한다
      // 보이지 않는 탭(자동화가 뒤에서 조작하는 탭)이 연 팝업 창은 포커스를 가져가지 않게 숨긴 채 만들고
      // did-create-window 에서 showInactive 로 띄운다 — 사람이 쓰던 창의 키 입력이 팝업으로 넘어가지 않게
      const quiet = openInBackground(tab.id, this.activeId)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          ...(quiet ? { show: false } : {}),
          // 팝업 창의 iframe 에도 preload 가 돌게. webPreferences 를 덮어쓰면 세션(partition)이 여는 탭에서
          // 물려지지 않아 팝업이 기본 프로필로 열렸다(실기: buyer01 탭의 SSG 배송지·로그인 팝업이 로그아웃 상태) —
          // 여는 탭의 파티션을 그대로 지정한다
          webPreferences: { nodeIntegrationInSubFrames: true, partition }
        }
      }
    })
    wc.on('did-create-window', (popupWin) => {
      this.registerPopup(popupWin, tab.id, profile)
      // 숨긴 채 만든 팝업(뒤 탭이 연 것)은 포커스 없이 보여 준다
      if (!popupWin.isDestroyed() && !popupWin.isVisible()) popupWin.showInactive()
    })
    if (tab.mobile) void applyMobileEmulation(wc)
    // 보관해 둔 로그인 쿠키를 되살리는 중이면 끝난 뒤에 연다(첫 요청에 로그인 쿠키가 실리게)
    const cookiesPending = cookieSnapshotReady(ses)
    if (cookiesPending) {
      // 기다리는 동안 다른 탐색(사람·자동화)이 먼저 시작됐으면 그쪽이 최신이므로 최초 주소로 덮지 않는다
      let superseded = false
      const onNav = (): void => {
        superseded = true
      }
      wc.on('did-start-navigation', onNav)
      void cookiesPending.then(() => {
        wc.off('did-start-navigation', onNav)
        if (!wc.isDestroyed() && !superseded) void wc.loadURL(url)
      })
    } else {
      void wc.loadURL(url)
    }
    if (opts.keepAgentTarget === true) {
      this.laneIds.add(tab.id)
      this.laneTouchedAt.set(tab.id, Date.now())
    }
    if (opts.background === true) {
      this.sizeHidden(tab)
    } else if (opts.keepAgentTarget === true) {
      // 레인 탭 — 레인이 제 작업 창을 쥐므로 전역 자동화 대상 표식은 그대로 둔다.
      // 보이는 탭이 있으면 언제나 뒤에서만 연다 — 레인은 보이지 않아도 제 탭을 조작하고 캡처는 withFront 가 맡는다.
      // (실기 2026-10-24: 사람이 60초 입력 없이 보기만 하면 세션 관리자의 계정 확인 탭이 5초마다 앞으로 올라와
      // 보던 탭이 다른 소싱처로 바뀌었다.) 보이는 탭이 없을 때(첫 탭)만 보여 준다
      if (this.activeId !== null && this.get(this.activeId) !== null) {
        this.sizeHidden(tab)
      } else {
        const kept = this.automationTabId
        this.activate(tab.id)
        this.automationTabId = kept
      }
    } else {
      // 자동화 흐름 + 사람이 쓰는 창이면 activate 가 보이는 탭 대신 자동화 대상 표식만 바꾼다
      this.activate(tab.id)
      if (this.activeId !== tab.id) this.sizeHidden(tab)
    }
    return this.list().find((t) => t.id === tab.id)!
  }

  /**
   * fn 이 도는 동안만 이 탭 뷰를 맨 위에 올린다(화면 캡처용). 뒤 층 탭은 보이는 탭에 완전히 가려져
   * 캡처가 안 된다("Current display surface not available for capture" — 실기 2026-09-28 네이버페이 키패드 OCR).
   * 끝나면 원래 보이던 탭을 다시 맨 위로 올린다. 활성 탭 표식(activeId)은 바꾸지 않는다
   */
  async withFront<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const tab = this.get(id)
    if (!tab || this.win.isDestroyed() || id === this.activeId || !isTabAlive(tab)) return fn()
    // 쉬던 레인 탭이면 먼저 깨운다 — 스로틀링을 켠 채 맨 위에 붙이고 끄면 그림이 멈춘다(sizeHidden 참고)
    this.touchLane(id)
    const visible = this.activeId !== null ? this.get(this.activeId) : null
    this.win.contentView.addChildView(tab.view)
    this.frontDepth++
    const startedAt = Date.now()
    paintDiag('front-start', { tab: shortId(id), visible: shortId(this.activeId) })
    try {
      return await fn()
    } finally {
      this.frontDepth--
      if (!this.win.isDestroyed() && visible && isTabAlive(visible)) {
        this.win.contentView.addChildView(visible.view)
      }
      paintDiag('front-end', { tab: shortId(id), ms: Date.now() - startedAt, ...this.stackInfo() })
    }
  }

  /** contentView 자식 순서(아래 → 위)를 탭 id 로 바꾼다. 탭이 아닌 뷰(확장 팝업 등)는 null */
  private stackIds(): Array<string | null> {
    if (this.win.isDestroyed()) return []
    return this.win.contentView.children.map((child) => {
      const tab = this.tabs.find((t) => t.view === child)
      return tab ? tab.id : null
    })
  }

  /** 진단 기록용 층 요약 — 맨 위 탭과 보이는 탭이 같은지, 보이는 탭 크기, 붙어 있는 뷰 수 */
  private stackInfo(): Record<string, unknown> {
    const order = this.stackIds()
    const active = this.active()
    const bounds = active && isTabAlive(active) ? active.view.getBounds() : null
    return {
      active: shortId(this.activeId),
      top: shortId(topTabId(order)),
      mismatch: stackMismatch(order, this.activeId),
      views: order.length,
      behind: this.behindIds.length,
      size: bounds ? `${bounds.width}x${bounds.height}` : '-'
    }
  }

  /**
   * 보이는 탭이 맨 위 탭이 아니면(다른 탭이 가림) 층을 다시 쌓는다. 실기에서 DOM 은 정상인데 흰 화면만
   * 보이던 상태를 잡으려는 점검이다. 복구가 계속 안 먹을 때 무한히 다시 쌓지 않게 횟수를 제한한다
   */
  private checkStack(): void {
    if (this.disposed || this.win.isDestroyed() || this.win.isMinimized() || !this.win.isVisible()) return
    if (this.frontDepth > 0 || this.gateHidden) return
    const tab = this.active()
    if (!tab || !isTabAlive(tab)) return
    if (!stackMismatch(this.stackIds(), this.activeId)) return
    if (!this.healGate.allow(Date.now())) {
      paintDiag('stack-mismatch-skip', this.stackInfo())
      return
    }
    paintDiag('stack-mismatch', this.stackInfo())
    this.activate(tab.id, { repaint: true })
    this.repaintView(tab)
    paintDiag('stack-healed', this.stackInfo())
  }

  /**
   * 보이는 탭을 다시 그리게 한다(Ctrl+Alt+R · 화면 캡처가 멈췄을 때). 모든 탭 뷰를 떼었다 순서대로 다시
   * 붙이고(activate 와 같은 순서), 크기를 흔들어 페이지 전체를 다시 칠하라고 요청한다(repaintView).
   * 자동화 대상 표식·방문 기록은 건드리지 않는다. 다시 그릴 탭이 없으면 false
   */
  repaintActive(reason: string): boolean {
    const tab = this.active()
    if (this.disposed || this.win.isDestroyed() || !tab || !isTabAlive(tab)) return false
    paintDiag('repaint', { reason, ...this.stackInfo() })
    this.activate(tab.id, { repaint: true })
    this.repaintView(tab)
    paintDiag('repaint-done', { reason, ...this.stackInfo() })
    return true
  }

  /**
   * 특정 탭을 다시 그리게 한다. 보이는 탭이면 repaintActive 와 같고, 뒤 층 탭(자동화 대상·레인)이면 층은 두고
   * 크기 흔들기만 한다. 탭이 아닌 대상(팝업)이거나 이미 죽었으면 false — 호출부가 거짓으로 '복구했다'고 안내하지 않게 한다
   */
  repaintTab(id: string, reason: string): boolean {
    if (id === this.activeId) return this.repaintActive(reason)
    const tab = this.get(id)
    if (this.disposed || this.win.isDestroyed() || !tab || !isTabAlive(tab)) return false
    // 크기가 0 인 뒤 탭(로그인 게이트 중 등)은 repaintView 가 아무 일도 안 한다 — 다시 그렸다고 하지 않는다
    const b = tab.view.getBounds()
    if (b.width < 2 || b.height < 2) return false
    paintDiag('repaint-behind', { reason, tab: shortId(id), ...this.stackInfo() })
    this.repaintView(tab)
    return true
  }

  /** 사람이 이 창을 쓰는 중이라 자동화가 보이는 탭·창 포커스를 바꾸면 안 되는가(visible-guard.ts) */
  private holdVisible(): boolean {
    if (this.win.isDestroyed()) return false
    return shouldHoldVisible(isAutomation(), lastHumanInWindowAt(this.win), Date.now())
  }

  /** 탭·팝업의 사람 입력(키 입력·마우스 누름)을 탭과 이 창에 기록한다. 자동화가 보낸 입력은 빼고 센다 */
  private watchHumanInput(wc: WebContents): void {
    const note = (kind: 'key' | 'pointer'): void => {
      if (!isHumanInputEvent(wc)) return
      const now = Date.now()
      markHuman(wc, now, kind)
      if (!this.win.isDestroyed()) markHumanInWindow(this.win, now)
    }
    wc.on('before-input-event', () => note('key'))
    wc.on('before-mouse-event', (_e, mouse) => {
      if (isHumanMouseInput(mouse.type)) note('pointer')
    })
  }

  /**
   * 뒤에서 조작할 탭을 보이는 탭 아래 층에 붙이고 같은 크기를 준다.
   * 창에 붙지 않은 뷰는 크기만 줘도 innerHeight 가 0 이라 뷰포트 판정이 전부 false 가 되고
   * 스냅샷이 페이지 끝 구매 버튼을 잘라 먹었다(c7d1e5a 회귀). contentView 0번(맨 아래)에 붙이므로
   * 사람 화면은 보이는 탭이 그대로 가리고, 포커스는 주지 않는다(webContents.focus·win.focus 를 부르지 않는다)
   */
  private sizeHidden(tab: Tab): void {
    if (this.disposed || this.win.isDestroyed() || !isTabAlive(tab)) return
    // 보이는 탭의 크기·층은 applyBounds·activate 가 맡는다
    if (tab.id === this.activeId) return
    this.setBehindBounds(tab)
    if (this.behindIds.includes(tab.id)) return
    this.behindIds.push(tab.id)
    // 보이는 탭에 가려진 뷰도 타이머·requestAnimationFrame 이 늦춰지지 않게 한다(가려짐 판정 스로틀링 방지).
    // 순서가 중요하다 — 반드시 붙이기 **전에** 끈다. 스로틀링이 켜진 채 붙인 뒤 끄면 그 뷰는 다시 그려지지 않고
    // capturePage 도 돌아오지 않는다(격리 실험 2026-10-24: 붙이고 끄기 6/6 멈춤·크기 흔들기·invalidate 로도 안 풀림,
    // 끄고 붙이기 6/6 정상 0.1초). 뗀 상태에서 스로틀링을 바꾸고 붙이면 멈춘 뷰도 바로 살아난다
    tab.view.webContents.setBackgroundThrottling(false)
    this.win.contentView.addChildView(tab.view, 0)
  }

  /**
   * 레인이 이 탭(또는 이 탭이 띄운 팝업)을 쓴다고 알린다. 쉬느라 뒤 층에서 떼어 둔 탭이면 다시 붙인다.
   * 레인 보기(lane-tabs)의 agentTarget·withFront 가 부른다. 레인 탭이 아니면 아무 일도 하지 않는다
   */
  touchLane(id: string): void {
    if (this.disposed) return
    const popup = this.popupById(id)
    const tabId = popup ? popup.openerId : id
    if (!this.laneIds.has(tabId)) return
    this.laneTouchedAt.set(tabId, Date.now())
    const tab = this.get(tabId)
    if (tab && tabId !== this.activeId && !this.behindIds.includes(tabId)) {
      this.sizeHidden(tab)
      paintDiag('lane-wake', { tab: shortId(tabId), ...this.stackInfo() })
    }
    // 페이지를 비워 둔 탭이면 원래 주소를 다시 연다(레인 호출 앞에서 runner 가 whenRestored 로 기다린다)
    if (tab) void this.restoreTab(tab)
  }

  /**
   * 비워 둔 탭의 원래 주소를 다시 연다. 이미 여는 중이면 그 약속을 돌려준다. 비워 둔 탭이 아니면 곧바로 끝난다.
   * 같은 WebContents 에서 여므로 쿠키·localStorage·sessionStorage 는 그대로다. 뒤로 가기 목록의 빈 페이지 항목은 지운다
   */
  restoreTab(tab: Tab): Promise<void> {
    if (tab.restoring) return tab.restoring
    const saved = tab.discarded
    if (!saved || !isTabAlive(tab)) return Promise.resolve()
    tab.discarded = undefined
    const wc = tab.view.webContents
    paintDiag('lane-restore', { tab: shortId(tab.id) })
    const run = (async (): Promise<void> => {
      // 비우는 이동이 아직 끝나지 않았으면 먼저 멈춘다 — 그대로 두면 빈 페이지의 로드 완료가 아래 loadURL 의 완료로 잡혀
      // 원래 주소로 넘어가기 전에 끝난 것처럼 보였다(통합 시험: 부하가 높을 때 새 렌더러가 수십 초 늦게 떠서 겹침)
      if (wc.isLoading()) wc.stop()
      try {
        await wc.loadURL(saved.url)
      } catch {
        // 리다이렉트로 끊긴 로드(ERR_ABORTED) 등 — 페이지는 이미 그 주소로 가고 있다
      }
      if (wc.isDestroyed()) return
      // 원래 주소로 넘어가지도 못했으면(네트워크 끊김 등으로 빈 페이지에 머묾) 원래 주소를 되돌려 둔다 — 다음에 쓸 때 다시 연다
      if (wc.getURL() === DISCARDED_PAGE_URL) {
        tab.discarded = saved
        paintDiag('lane-restore-failed', { tab: shortId(tab.id) })
        return
      }
      // 원래 주소로 돌아오며 렌더러 프로세스가 바뀐다. 뒤 층에 붙은 채 바뀐 새 렌더러는 '가려짐'으로 시작해 그리지 않을 수
      // 있어(통합 시험) 검증된 순서(떼기 → 스로틀링 끄기 → 붙이기)로 한 번 더 깨운다. 보이는 탭은 그대로 둔다
      if (this.behindIds.includes(tab.id) && tab.id !== this.activeId && !this.win.isDestroyed()) {
        this.win.contentView.removeChildView(tab.view)
        wc.setBackgroundThrottling(false)
        this.win.contentView.addChildView(tab.view, 0)
      }
      // 새 렌더러가 첫 화면을 그릴 때까지 기다린다 — 곧바로 찍으면 빈 이미지가 나왔다(통합 시험: 0초 빈 이미지, 0.3초 뒤 정상).
      // 뒤 층에서 뗀 채라 그리지 않는 탭이면 제한 시간에서 끝난다
      await Promise.race([
        wc.executeJavaScript(FIRST_PAINT_JS).catch(() => undefined),
        new Promise((r) => setTimeout(r, FIRST_PAINT_WAIT_MS))
      ])
      if (wc.isDestroyed()) return
      // [.., 원래 페이지, 빈 페이지, 원래 페이지] 에서 빈 페이지 항목을 지워 뒤로 가기가 빈 페이지로 가지 않게 한다
      try {
        const h = wc.navigationHistory
        const entries = h.getAllEntries()
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].url === DISCARDED_PAGE_URL && i !== h.getActiveIndex()) h.removeEntryAtIndex(i)
        }
      } catch {
        // 지우지 못해도 페이지 복구에는 지장이 없다
      }
    })()
    tab.restoring = run.finally(() => {
      tab.restoring = undefined
      this.emit()
    })
    this.emit()
    return tab.restoring
  }

  /**
   * 비워 둔 탭을 다시 열고 있으면 끝날 때까지(최대 45초) 기다린다. 도구 호출 직전에 runner 가 부른다.
   * 원래 페이지가 준비됐으면(또는 비운 탭이 아니면) true, 아직 여는 중이거나 다시 열지 못했으면 false —
   * runner 는 false 면 도구를 실행하지 않는다(빈 페이지·덜 뜬 문서를 조작하지 않게)
   */
  async whenRestored(id: string): Promise<boolean> {
    const tab = this.get(id)
    if (!tab) return true
    const p = tab.discarded ? this.restoreTab(tab) : tab.restoring
    if (!p) return true
    await Promise.race([p, new Promise<void>((r) => setTimeout(r, RESTORE_WAIT_MS))])
    return !tab.discarded && !tab.restoring
  }

  /**
   * 오래 쉰 레인 탭 하나의 페이지를 비워 메모리를 돌려준다(점검마다 한 개씩 — 한꺼번에 몰리지 않게).
   * 비우는 조건: 뒤 층에서 이미 뗀 레인 탭, 마지막으로 쓴 지 DISCARD_IDLE_MS 지남, 보이는 탭·자동화 대상·진행 중 호출 아님,
   * 불러오는 중 아님, 그 탭이 띄운 팝업 없음, 주문·결제·로그인 화면 아님(discardableUrl),
   * 페이지를 누른 적 없고 입력하다 만 칸 없음(discardableProbe — 이동 때 '떠나시겠습니까' 창이 뜨지 않게)
   */
  private discardIdleLane(): void {
    if (!LANE_DISCARD_ENABLED) return
    if (this.disposed || this.win.isDestroyed() || this.frontDepth > 0 || this.discarding) return
    const now = Date.now()
    const hot = this.hotLanes()
    const candidate = this.tabs.find((t) => this.canDiscard(t, hot, now))
    if (!candidate) return
    const wc = candidate.view.webContents
    const url = wc.getURL()
    this.discarding = true
    void Promise.race([
      wc.executeJavaScript(PAGE_KEEP_PROBE_JS).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), DISCARD_PROBE_MS))
    ])
      .then((probe) => {
        // 확인하는 사이 사람이 열었거나 도구가 썼거나 주소가 바뀌었으면 비우지 않는다
        if (!this.canDiscard(candidate, this.hotLanes(), Date.now()) || wc.getURL() !== url) return
        if (!discardableProbe(probe)) {
          candidate.keepUrl = url
          paintDiag('lane-discard-skip', { tab: shortId(candidate.id), probe })
          return
        }
        candidate.discarded = { url, title: wc.getTitle() }
        paintDiag('lane-discard', { tab: shortId(candidate.id) })
        wc.loadURL(DISCARDED_PAGE_URL).catch(() => {
          // 비우지 못했으면(페이지가 이동을 막음 등) 원래 상태로 둔다
          if (!isTabAlive(candidate) || wc.getURL() !== DISCARDED_PAGE_URL) {
            candidate.discarded = undefined
            candidate.keepUrl = url
          }
        })
        this.emit()
      })
      .finally(() => {
        this.discarding = false
      })
  }

  private canDiscard(t: Tab, hot: ReadonlySet<string>, now: number): boolean {
    if (!isTabAlive(t) || t.discarded || t.restoring) return false
    if (!this.laneIds.has(t.id) || hot.has(t.id)) return false
    if (t.id === this.activeId || t.id === this.automationTabId || this.behindIds.includes(t.id)) return false
    const at = this.laneTouchedAt.get(t.id)
    if (at === undefined || now - at < DISCARD_IDLE_MS) return false
    const wc = t.view.webContents
    if (wc.isLoading() || wc.isCurrentlyAudible()) return false
    const url = wc.getURL()
    if (url === t.keepUrl || !discardableUrl(url)) return false
    // 이 탭이 띄운 팝업(결제창·인증창)이 살아 있으면 부모 페이지가 결과를 받아야 한다
    if (this.popups.alive().some((p) => p.openerId === t.id)) return false
    return true
  }

  /**
   * 레인 도구 호출이 도는 동안 그 레인 탭들을 쉬게 하지 않는다(문자 인증 대기·run_script 처럼 1분 넘는 호출).
   * 돌려준 함수를 호출이 끝날 때 부른다 — 쉬는 시간은 끝난 때부터 다시 센다.
   * ids 는 복사하지 않고 그대로 붙잡는다 — 레인의 탭 집합(LaneState.owned)을 넘기면 호출 도중 새로 연 탭도 붙잡힌다
   */
  holdLanes(ids: ReadonlySet<string>): () => void {
    const key = Symbol('lane-hold')
    this.laneHolds.set(key, ids)
    const now = Date.now()
    for (const id of ids) if (this.laneIds.has(id)) this.laneTouchedAt.set(id, now)
    return () => {
      if (!this.laneHolds.delete(key)) return
      const end = Date.now()
      for (const id of ids) if (this.laneIds.has(id)) this.laneTouchedAt.set(id, end)
    }
  }

  /** 한동안 안 쓴 레인 탭을 뒤 층에서 뗀다(그리기를 멈춰 CPU 를 아낀다). 다시 쓰면 touchLane 이 붙인다 */
  private sleepIdleLanes(): void {
    if (this.disposed || this.win.isDestroyed() || this.frontDepth > 0) return
    const hot = this.hotLanes()
    const idle = this.behindIds.filter(
      (id) => this.laneIds.has(id) && !hot.has(id) && id !== this.automationTabId
    )
    if (idle.length === 0) return
    this.pruneBehind()
    paintDiag('lane-sleep', { count: idle.length, ...this.stackInfo() })
  }

  private hotLanes(): Set<string> {
    const busy = new Map<string, number>()
    for (const ids of this.laneHolds.values()) {
      for (const id of ids) busy.set(id, (busy.get(id) ?? 0) + 1)
    }
    return hotLaneIds({
      laneIds: this.laneIds,
      touchedAt: this.laneTouchedAt,
      busy,
      now: Date.now()
    })
  }

  /** 뒤 탭 크기 — 보이는 탭과 같다. 로그인 게이트 중이면 0(게이트 화면 위로 비치지 않게) */
  private setBehindBounds(tab: Tab): void {
    if (this.gateHidden) {
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    const [w, h] = this.win.getContentSize()
    tab.view.setBounds(computeViewBounds(this.layout, w, h, tab.mobile))
  }

  /** 더는 뒤에서 조작하지 않는 탭(자동화 대상도 레인도 아님)을 뒤 층에서 뗀다. 보이는 탭은 떼지 않는다 */
  private pruneBehind(): void {
    if (this.disposed || this.win.isDestroyed()) return
    const alive = new Set(this.tabs.filter((t) => isTabAlive(t)).map((t) => t.id))
    const { keep, drop } = splitBehind({
      behind: this.behindIds,
      activeId: this.activeId,
      automationId: this.automationTabId,
      // 쉬는 레인 탭은 붙여 둘 대상에서 뺀다(sleepIdleLanes)
      laneIds: this.hotLanes(),
      alive
    })
    this.behindIds = keep
    for (const id of drop) {
      const t = this.get(id)
      if (!t || !isTabAlive(t)) continue
      if (id !== this.activeId) this.win.contentView.removeChildView(t.view)
      t.view.webContents.setBackgroundThrottling(true)
    }
  }

  /** 자동화가 조작할 진짜 탭(팝업 제외). 자동화 대상 표식이 살아 있으면 그 탭, 아니면 보이는 탭 */
  workingTab(): Tab | null {
    const id = this.workingTabId()
    return id ? this.get(id) : null
  }

  /** 자동화 대상 표식을 지운다 — 사용자가 새 AI 지시를 내리면 다시 보이는 탭부터 조작한다 */
  clearAgentTarget(): void {
    this.automationTabId = null
    this.pruneBehind()
  }

  private workingTabId(): string | null {
    const alive = this.tabs.filter((t) => isTabAlive(t)).map((t) => t.id)
    const id = pickWorkingTabId(this.automationTabId, alive, this.activeId)
    // 표식이 가리키던 탭이 닫혔으면 표식을 지운다
    if (this.automationTabId !== null && id !== this.automationTabId) this.automationTabId = null
    return id
  }

  /**
   * opts.repaint — 이미 보이는 탭의 층을 다시 쌓기만 한다(repaintActive·층 점검). 사람이 쓰는 중이어도 막지 않고,
   * 자동화 대상 표식과 방문 기록은 그대로 둔다
   */
  activate(id: string, opts?: { repaint?: boolean }): void {
    const tab = this.get(id)
    if (!tab || this.win.isDestroyed()) return
    const repaint = opts?.repaint === true
    if (!repaint) {
      // 보거나 자동화 대상으로 고른 레인 탭은 '쓴' 것으로 친다 — 떠난 탭도 방금까지 본 것이라 곧바로 비우지 않는다
      const now = Date.now()
      for (const t of [id, this.activeId]) if (t !== null && this.laneIds.has(t)) this.laneTouchedAt.set(t, now)
      // 비워 둔 탭이면 원래 페이지를 다시 연다
      void this.restoreTab(tab)
    }
    // 자동화 흐름인데 사람이 이 창을 쓰는 중이면 보이는 탭은 두고 자동화 대상 표식만 옮긴다
    // (실기 2026-09-27: 브리지의 new_tab·switch_tab 이 로그인하던 탭을 가려 로그인을 못 했다)
    // 보이는 탭이 닫혀 없으면(close 가 다음 탭을 보일 때) 막지 않는다 — 빈 화면으로 둘 수는 없다
    const visibleAlive = this.activeId !== null && this.get(this.activeId) !== null
    if (!repaint && visibleAlive && this.holdVisible()) {
      this.automationTabId = id === this.activeId ? null : id
      this.sizeHidden(tab)
      this.pruneBehind()
      return
    }
    // 보이는 탭이 곧 자동화 대상이 된다 — 자동화가 바꿨거나, 사람이 자동화 대상 탭을 직접 눌렀을 때.
    // 사람이 다른 탭을 누른 것은 표식을 지우지 않는다(뒤에서 돌던 자동화가 사람의 탭으로 옮겨 오지 않게)
    if (!repaint && ((isAutomation() && visibleAlive) || this.automationTabId === id)) {
      this.automationTabId = null
    }
    // 탭 뷰를 다시 얹기 전에 알린다 — 위에 떠 있던 확장 팝업이 탭 뷰 아래로 묻히지 않게
    for (const cb of this.activatedListeners) cb()
    // 모든 탭 뷰를 창에서 제거(없으면 무시됨)한 뒤 뒤 탭은 맨 아래부터, 활성 탭은 맨 위에 다시 추가한다
    for (const t of this.tabs) {
      this.win.contentView.removeChildView(t.view)
    }
    // 가려지는 레인 탭은 뒤 층으로 내린다 — 레인은 보이지 않아도 제 탭을 계속 조작한다
    const prev = this.activeId !== null && this.activeId !== id ? this.get(this.activeId) : null
    if (
      prev &&
      isTabAlive(prev) &&
      this.laneIds.has(prev.id) &&
      !this.behindIds.includes(prev.id)
    ) {
      this.behindIds.push(prev.id)
      prev.view.webContents.setBackgroundThrottling(false)
    }
    // 뒤 층(레인·자동화)에 있던 탭이 앞으로 나올 때는 그림을 다시 그리게 한다 — 크기가 뒤 층 때와 같아 setBounds 가
    // 아무 일도 안 하고, 한 번도 앞에 나온 적 없는 뷰는 하얀 채로 남는 일이 있었다(실기 2026-10-24: 어떤 탭은 보이고 어떤 탭은 안 보임)
    const wasBehind = this.behindIds.includes(id)
    this.activeId = id
    // 보이는 탭이 된 뒤 탭은 뒤 목록에서 빠지며 스로틀링이 원래대로(true) 돌아온다
    this.pruneBehind()
    const behind = stackOrder(id, this.behindIds).slice(0, -1)
    behind.forEach((behindId, i) => {
      const t = this.get(behindId)
      // 확장 팝업 뷰 등 다른 뷰보다도 아래에 둔다
      if (t && isTabAlive(t)) this.win.contentView.addChildView(t.view, i)
    })
    this.win.contentView.addChildView(tab.view)
    if (!repaint) this.noteVisit(tab.view.webContents.getURL())
    this.applyBounds()
    if (wasBehind) this.repaintView(tab)
    this.emit()
    paintDiag(repaint ? 'activate-repaint' : 'activate', {
      id: shortId(id),
      wasBehind,
      ...this.stackInfo()
    })
  }

  /** 크기를 1px 줄였다 되돌리고 invalidate 로 다시 그리게 한다(하얗게 남은 뒤 층 출신 뷰를 깨운다) */
  private repaintView(tab: Tab): void {
    if (!isTabAlive(tab)) return
    const b = tab.view.getBounds()
    if (b.width < 2 || b.height < 2) return
    tab.view.setBounds({ ...b, width: b.width - 1 })
    tab.view.setBounds(b)
    tab.view.webContents.invalidate()
    // 같은 틱의 두 setBounds 는 합쳐질 수 있어 한 번 더 늦게 확인한다
    setTimeout(() => {
      if (this.disposed || this.win.isDestroyed() || !isTabAlive(tab) || this.activeId !== tab.id) return
      const cur = tab.view.getBounds()
      tab.view.setBounds({ ...cur, width: cur.width - 1 })
      tab.view.setBounds(cur)
      tab.view.webContents.invalidate()
    }, 80)
  }

  /** 팝업 창을 부모(메인) 창 가운데로 옮긴다. 화면 밖으로 나가지 않게 최소 0 으로 붙잡는다 */
  private centerPopup(win: BrowserWindow): void {
    if (this.win.isDestroyed() || win.isDestroyed()) return
    const parent = this.win.getBounds()
    const size = win.getSize()
    const x = Math.max(0, Math.round(parent.x + (parent.width - size[0]) / 2))
    const y = Math.max(0, Math.round(parent.y + (parent.height - size[1]) / 2))
    win.setPosition(x, y)
  }

  /** 팝업 창을 추적 목록에 넣고, 닫히면 뺀다. 페이지 조작 훅은 탭과 같은 것을 붙인다 */
  private registerPopup(win: BrowserWindow, openerId: string, profile: string): void {
    const popup = this.popups.add({
      id: randomUUID(),
      win,
      openerId,
      profile,
      handle: {
        isDestroyed: () => win.isDestroyed(),
        hide: () => win.hide(),
        close: () => win.close(),
        destroy: () => win.destroy()
      }
    })
    // 크롬처럼 부모 창 가운데에 띄운다(기본값은 화면 왼쪽 위라 결제창이 엉뚱한 곳에 떴다).
    // 페이지가 left/top 을 지정했으면 Electron 이 이미 반영했으므로 그 경우는 두고,
    // 아니면 부모 창 기준으로 가운데 정렬한다
    this.centerPopup(win)
    const wc = win.webContents
    this.contextMenuHook?.(wc)
    wc.on('dom-ready', () => this.sendGestureConfig(wc))
    // 팝업도 탭과 똑같이 막는다 — 결제창에서 file:// 로 넘어가면 로컬 DB 파일이
    // 그대로 읽힌다. 확장 문서는 팝업으로 열 일이 없으므로 허용하지 않는다
    guardNavigation(wc, false)
    // 팝업(결제창·로그인 창)에서도 사람의 키 입력·마우스 누름을 기록한다(부모 창 단위로도 남는다)
    this.watchHumanInput(wc)
    // 페이지 JS 대화상자도 탭과 같은 정책으로 처리한다(결제창의 alert 가 작업을 멈추지 않게)
    installDialogHandler(wc, {
      isAutomationActive: () =>
        isAutomationActive(this.agentRunning(), process.env, !app.isPackaged),
      // 팝업 창은 포커스를 가지고 있을 때만 사람이 보고 있다고 본다
      isUserFacing: () => !win.isDestroyed() && win.isFocused() && !win.isMinimized(),
      mode: () => this.dialogMode(),
      ...(this.dialogConfirm ? { confirm: this.dialogConfirm } : {}),
      onMessage: (message) => this.lastDialogMessage.set(popup.id, message)
    })
    // 팝업이 또 창을 열면(결제 → 인증창) 같은 규칙으로 창을 만든다
    wc.setWindowOpenHandler(({ url: target }) => {
      if (!isAllowedUrl(target)) return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          // 여는 창과 같은 세션(partition)을 명시한다 — 덮어쓴 webPreferences 는 세션을 물려받지 않는다
          webPreferences: {
            nodeIntegrationInSubFrames: true,
            partition: this.get(openerId)?.partition ?? `${this.partitionPrefix}${profile}`
          }
        }
      }
    })
    wc.on('did-create-window', (child) => this.registerPopup(child, openerId, profile))
    win.on('close', (event) => this.popups.handleClose(popup, () => event.preventDefault()))
    win.once('closed', () => {
      this.popups.remove(popup)
      this.lastDialogMessage.delete(popup.id)
      // AI 가 이 팝업을 보고 있었으면 표식을 지워 활성 탭으로 돌아가게 한다
      if (this.focusedPopupId === popup.id) this.focusedPopupId = null
      this.emit()
    })
    // 제목·주소가 정해진 뒤에 알려야 안내 문구가 빈 문자열이 되지 않는다
    wc.once('dom-ready', () => this.notifyPopupOpened(popup))
    this.emit()
  }

  /** 새로 열린 팝업을 구독자(AI 도구)와 렌더러에 알린다 */
  private notifyPopupOpened(popup: Popup): void {
    if (this.disposed || popup.handle.isDestroyed()) return
    const target = this.listTargets().find((t) => t.id === popup.id)
    if (target) for (const cb of this.popupOpenedListeners) cb(target)
    this.emit()
  }

  close(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const [tab] = this.tabs.splice(idx, 1)
    this.lastDialogMessage.delete(id)
    if (this.automationTabId === id) this.automationTabId = null
    this.behindIds = this.behindIds.filter((b) => b !== id)
    this.laneIds.delete(id)
    this.laneTouchedAt.delete(id)
    // 닫히기 전에 주소를 챙겨 둔다(제스처 '닫은 탭 다시 열기')
    if (isTabAlive(tab)) {
      const record: ClosedTabRecord = {
        // 비워 둔 탭이면 빈 페이지가 아니라 원래 주소를 남긴다
        url: tab.discarded?.url ?? tab.view.webContents.getURL(),
        profile: tab.profile,
        mobile: tab.mobile
      }
      for (const cb of this.closedListeners) cb(record)
    }
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view)
    if (isTabAlive(tab)) tab.view.webContents.close()
    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1]
      if (next) this.activate(next.id)
      else this.activeId = null
    }
    this.emit()
  }

  async navigate(id: string, input: string): Promise<void> {
    const tab = this.get(id)
    if (!tab) throw new Error('tab not found')
    const url = toUrl(input, this.searchEngine)
    if (!isAllowedUrl(url)) throw new Error(`${BLOCKED_URL_MESSAGE} (${url})`)
    await tab.view.webContents.loadURL(url)
  }

  back(id: string): void {
    this.get(id)?.view.webContents.navigationHistory.goBack()
  }

  forward(id: string): void {
    this.get(id)?.view.webContents.navigationHistory.goForward()
  }

  reload(id: string): void {
    this.get(id)?.view.webContents.reload()
  }

  async setMobile(id: string, mobile: boolean): Promise<void> {
    const tab = this.get(id)
    if (!tab) return
    tab.mobile = mobile
    // 뷰 bounds(가운데 정렬 여부)는 에뮬레이션 통신을 기다릴 필요 없이 즉시 반영한다
    this.applyBounds()
    const wc = tab.view.webContents
    // 에뮬레이션 적용/해제가 끝난 뒤에 새로고침해야 UA·뷰포트가 반영된다
    if (mobile) await applyMobileEmulation(wc)
    else {
      await clearMobileEmulation(wc)
      // 모바일 해제는 UA 를 앱 기본값으로 되돌린다 — 웹스토어에 머물러 있었다면
      // 설치 버튼이 사라지므로 지금 주소에 맞는 UA 를 다시 건다
      tab.refreshWebstoreUa?.()
    }
    if (!wc.isDestroyed()) wc.reload()
    this.emit()
  }

  setLayout(l: Layout): void {
    this.layout = l
    this.applyBounds()
  }

  /** 로그인 게이트 — true 면 활성 탭 뷰를 0 크기로 둔다(로그인 화면만 보인다) */
  setGateHidden(hidden: boolean): void {
    if (this.gateHidden === hidden) return
    this.gateHidden = hidden
    this.applyBounds()
  }

  // 저장된 좌표를 현재 창 크기에 맞춰 활성 탭에 적용. mobile 탭이면 가운데 412px 카드로 좁힌다
  private applyBounds(): void {
    if (this.disposed || this.win.isDestroyed()) return
    const tab = this.active()
    if (!tab) return
    // 뒤 층 탭도 창 크기·게이트를 따라가게 한다(크기가 어긋나면 좌표 클릭이 빗나간다)
    for (const id of this.behindIds) {
      const t = this.get(id)
      if (t && t !== tab && isTabAlive(t)) this.setBehindBounds(t)
    }
    if (this.gateHidden) {
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      return
    }
    const [w, h] = this.win.getContentSize()
    tab.view.setBounds(computeViewBounds(this.layout, w, h, tab.mobile))
    // 뒤에서 도는 자동화 대상 탭이 아직 뒤 층에 없으면 붙인다
    const working = this.automationTabId ? this.get(this.automationTabId) : null
    if (working && working !== tab) this.sizeHidden(working)
  }
}

// 주소창 입력 → URL. 도메인 형태면 https 붙이고, 아니면 검색엔진(기본 구글) 검색
export function toUrl(input: string, engine: SearchEngine = 'google'): string {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return s
  // 내부 페이지 주소(samba://newtab)는 검색어가 아니라 그대로 연다
  if (isInternalUrl(s)) return s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return `https://${s}`
  // === 검색엔진 설정 (신규 추가분) ==========================================
  if (engine === 'naver')
    return `https://search.naver.com/search.naver?query=${encodeURIComponent(s)}`
  // === 신규 추가분 끝 =========================================================
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}
