// @vitest-environment jsdom
// 제출 버튼 탐지 — 패스키·QR·일회용 번호 같은 다른 로그인 방식 버튼을 제출 버튼으로 고르지 않는다
// (실기 2026-10-17: 네이버 로그인 폼에서 "패스키 로그인"을 눌러 다른 계정 패스키로 로그인됨)
import { describe, it, expect } from 'vitest'
import { findSubmit } from '../src/preload/login-detect'

function naverLikeForm(): { registry: HTMLElement[]; login: HTMLElement; pw: HTMLElement } {
  document.body.innerHTML = `
    <form id="frmNIDLogin">
      <input id="id" name="id" type="text">
      <input id="pw" name="pw" type="password">
      <button id="passkey_btn" class="btn_passkey">패스키 로그인</button>
      <button id="log.login" class="btn_login" type="submit">로그인</button>
      <a href="#none">QR 코드 로그인</a>
      <a href="#none">일회용 번호 로그인</a>
    </form>`
  const registry = Array.from(document.querySelectorAll<HTMLElement>('input, button, a'))
  return {
    registry,
    login: document.getElementById('log.login') as HTMLElement,
    pw: document.getElementById('pw') as HTMLElement
  }
}

describe('findSubmit — 다른 로그인 방식 버튼 제외', () => {
  it('폼 안에 "패스키 로그인"이 먼저 있어도 실제 "로그인" 버튼을 고른다', () => {
    const { registry, login, pw } = naverLikeForm()
    const id = findSubmit(registry, pw)
    expect(id).toBe(registry.indexOf(login) + 1)
  })

  it('폼 밖에서 찾을 때도 패스키·QR·일회용 번호 버튼은 고르지 않는다', () => {
    document.body.innerHTML = `
      <button>패스키 로그인</button>
      <div role="button">QR 코드 로그인</div>
      <button type="button">로그인</button>`
    const registry = Array.from(document.querySelectorAll<HTMLElement>('button, [role=button]'))
    expect(findSubmit(registry)).toBe(3)
  })

  it('페이지 전체를 감싼 폼에서 머리말 검색 버튼보다 로그인 버튼을 고른다(ABC마트)', () => {
    document.body.innerHTML = `
      <form id="whole">
        <input name="searchWord" type="text">
        <button class="btn-smart">스마트 서치</button>
        <button class="btn-search">통합 검색</button>
        <input name="username" type="text">
        <input name="password" type="password">
        <button type="button">아이디 찾기</button>
        <input type="button" id="btnLogin" value="로그인">
      </form>`
    const registry = Array.from(document.querySelectorAll<HTMLElement>('input, button'))
    const pw = document.querySelector<HTMLElement>('input[name=password]') as HTMLElement
    const login = document.getElementById('btnLogin') as HTMLElement
    expect(findSubmit(registry, pw)).toBe(registry.indexOf(login) + 1)
  })
})
