// 로그인 팝업(OAuth)은 열어 준 창(window.opener)과 연결이 유지돼야 한다.
//
// 삼바 브라우저는 크기를 지정하지 않은 window.open(url, '_blank') 를 크롬처럼 "새 탭"으로 열려고 'deny' 한 뒤 탭을 따로 만든다.
// 그러면 페이지가 받는 window 참조는 null 이고 새 탭에는 opener 가 없다. OK캐쉬백의 카카오 로그인은
// window.open(kauth.kakao.com …) 로 창을 연 뒤, 돌아온 창이 window.opener.kakaoCallback(code) 로 코드를 넘기고
// opener 가 없으면 "잘못된 접근입니다" 를 띄운다(2026-10-25 실측: 콜백 페이지 코드·window.open 이 null 로 돌아옴).
// 그래서 이런 로그인 주소는 탭이 아니라 연결이 유지되는 별도 창으로 연다(결제창·인증창과 같은 경로).

/** opener 연결이 필요한 로그인 호스트(등록 도메인 단위가 아니라 로그인에 쓰는 호스트만) */
const OPENER_POPUP_HOSTS = ['kauth.kakao.com', 'accounts.kakao.com']

/** 이 주소를 window.open 으로 열 때 opener 를 유지하는 별도 창으로 열어야 하는가 */
export function needsOpenerPopup(url: string): boolean {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return OPENER_POPUP_HOSTS.some((h) => host === h)
}
