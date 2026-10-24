// 탭 확대·축소 판정. Electron 은 메뉴가 없으면 Ctrl+± 를 처리하지 않고(메뉴 단축키로만 동작),
// 이 앱은 메뉴를 숨겨 두므로 직접 처리한다. Chromium 이 호스트별 배율을 세션에 기억한다.

export type ZoomAction = 'in' | 'out' | 'reset'

/** before-input-event 가 주는 값 중 판정에 필요한 부분만 */
export interface ZoomInput {
  type: string
  key: string
  control: boolean
  alt: boolean
  meta: boolean
}

/** 크롬과 같은 범위(25%~500%)에 가깝게: 1.2^level. -3 ≈ 58%, 5 ≈ 249% */
export const ZOOM_MIN_LEVEL = -3
export const ZOOM_MAX_LEVEL = 5
export const ZOOM_STEP = 0.5

/** Ctrl(또는 Cmd)+`+`/`-`/`0` 이면 동작을, 아니면 null. Alt 가 함께 눌리면 다른 단축키라 받지 않는다 */
export function zoomKeyAction(input: ZoomInput): ZoomAction | null {
  if (input.type !== 'keyDown') return null
  if (!(input.control || input.meta) || input.alt) return null
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return null
}

/** 현재 배율 단계에서 한 칸 움직인 값(범위 안으로 자른다) */
export function nextZoomLevel(current: number, action: ZoomAction): number {
  if (action === 'reset') return 0
  const next = current + (action === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  return Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, next))
}
