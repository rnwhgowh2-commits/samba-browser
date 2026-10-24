import { describe, expect, it } from 'vitest'
import {
  nextZoomLevel,
  zoomKeyAction,
  ZOOM_MAX_LEVEL,
  ZOOM_MIN_LEVEL,
  type ZoomInput
} from '../src/main/browser/zoom'

const key = (over: Partial<ZoomInput>): ZoomInput => ({
  type: 'keyDown',
  key: '=',
  control: true,
  alt: false,
  meta: false,
  ...over
})

describe('탭 확대·축소 단축키', () => {
  it('Ctrl+= / Ctrl++ 는 확대, Ctrl+- 는 축소, Ctrl+0 은 원래 크기', () => {
    expect(zoomKeyAction(key({ key: '=' }))).toBe('in')
    expect(zoomKeyAction(key({ key: '+' }))).toBe('in')
    expect(zoomKeyAction(key({ key: '-' }))).toBe('out')
    expect(zoomKeyAction(key({ key: '0' }))).toBe('reset')
  })
  it('Ctrl 없이, Alt 와 함께, 키를 뗄 때는 무시한다', () => {
    expect(zoomKeyAction(key({ control: false }))).toBeNull()
    expect(zoomKeyAction(key({ alt: true }))).toBeNull()
    expect(zoomKeyAction(key({ type: 'keyUp' }))).toBeNull()
    expect(zoomKeyAction(key({ key: 'a' }))).toBeNull()
  })
  it('Mac 의 Cmd 도 받는다', () => {
    expect(zoomKeyAction(key({ control: false, meta: true, key: '-' }))).toBe('out')
  })
  it('배율은 한 칸씩 움직이고 범위를 넘지 않는다', () => {
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0, 'out')).toBe(-0.5)
    expect(nextZoomLevel(3, 'reset')).toBe(0)
    expect(nextZoomLevel(ZOOM_MAX_LEVEL, 'in')).toBe(ZOOM_MAX_LEVEL)
    expect(nextZoomLevel(ZOOM_MIN_LEVEL, 'out')).toBe(ZOOM_MIN_LEVEL)
  })
})
