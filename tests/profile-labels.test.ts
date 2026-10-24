// 프로필 → 계정 이름표: 파일이 깨지거나 없어도 탭 목록이 멀쩡해야 한다

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createProfileLabelReader,
  parseProfileLabels,
  parseSitesAccountLabels,
  parseSitesProfileSites,
  parseSitesWorkspace
} from '../src/main/browser/profile-labels'

describe('parseProfileLabels', () => {
  it('프로필 이름 → 계정 이름을 읽는다', () => {
    expect(parseProfileLabels('{"musinsa-2":"cdhking00","lfmall-3":"kapital473"}')).toEqual({
      'musinsa-2': 'cdhking00',
      'lfmall-3': 'kapital473'
    })
  })

  it('깨진 파일·배열·문자열이 아닌 값·빈 값·너무 긴 값은 버린다', () => {
    expect(parseProfileLabels('not json')).toEqual({})
    expect(parseProfileLabels('[1,2]')).toEqual({})
    expect(parseProfileLabels('{"a":1,"b":"","c":"  ","d":"' + 'x'.repeat(41) + '","e":" ok "}')).toEqual({ e: 'ok' })
  })
})

describe('createProfileLabelReader', () => {
  it('파일이 없으면 이름표가 없다', () => {
    const read = createProfileLabelReader(join(tmpdir(), 'no-such-profile-labels.json'))
    expect(read('musinsa-2')).toBeUndefined()
  })

  it('파일이 바뀌면 다시 읽는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plabel-'))
    try {
      const file = join(dir, 'profile-labels.json')
      writeFileSync(file, '{"musinsa-2":"cdhking00"}')
      const read = createProfileLabelReader(file)
      expect(read('musinsa-2')).toBe('cdhking00')
      expect(read('musinsa-3')).toBeUndefined()
      // 수정 시각이 같으면 캐시를 쓰므로 시각을 확실히 어긋나게 한다
      const later = new Date(Date.now() + 5000)
      writeFileSync(file, '{"musinsa-2":"changed"}')
      utimesSync(file, later, later)
      expect(read('musinsa-2')).toBe('changed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parseSitesAccountLabels', () => {
  it('sites.json 의 accounts 에서 프로필 → 계정 이름을 만든다', () => {
    const text = JSON.stringify({
      sites: [
        { id: 'MUSINSA', accounts: [{ profile: 'musinsa-2', accountLabel: 'cdhking00' }] },
        { id: 'LFmall', accounts: [{ profile: 'default', accountLabel: 'ditodalal' }, { profile: 'lfmall-2', accountLabel: 'youngae0047' }] },
        { id: 'LEE', enabled: false, accounts: [{ profile: 'lee-1', accountLabel: 'x' }] },
        { id: 'SSG' }
      ]
    })
    expect(parseSitesAccountLabels(text)).toEqual({ 'musinsa-2': 'cdhking00', 'lfmall-2': 'youngae0047' })
  })

  it('깨졌거나 sites 가 없으면 빈 지도', () => {
    expect(parseSitesAccountLabels('nope')).toEqual({})
    expect(parseSitesAccountLabels('{}')).toEqual({})
  })
})

describe('parseSitesProfileSites', () => {
  it('프로필 → 소싱처 id', () => {
    const text = JSON.stringify({
      sites: [
        { id: 'MUSINSA', accounts: [{ profile: 'musinsa-2', accountLabel: 'cdhking00' }] },
        { id: 'LFmall', accounts: [{ profile: 'default', accountLabel: 'a' }, { profile: 'lfmall-2', accountLabel: 'b' }] }
      ]
    })
    expect(parseSitesProfileSites(text)).toEqual({ 'musinsa-2': 'MUSINSA', 'lfmall-2': 'LFmall' })
    expect(parseSitesProfileSites('x')).toEqual({})
  })
})

describe('parseSitesWorkspace', () => {
  it('sites.json 최상위 workspaceId 를 읽는다', () => {
    expect(parseSitesWorkspace('{"workspaceId":2,"sites":[]}')).toEqual({ workspaceId: '2' })
  })

  it('정수가 아니거나 없으면 빈 지도(현재 작업공간을 쓴다)', () => {
    expect(parseSitesWorkspace('{"workspaceId":"2"}')).toEqual({})
    expect(parseSitesWorkspace('{"workspaceId":0}')).toEqual({})
    expect(parseSitesWorkspace('{"workspaceId":2.5}')).toEqual({})
    expect(parseSitesWorkspace('{}')).toEqual({})
    expect(parseSitesWorkspace('nope')).toEqual({})
  })
})
