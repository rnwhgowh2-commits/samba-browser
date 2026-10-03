# 세션 관리자 (Session Keeper)

소싱처 로그인이 풀리지 않게 지키고, 풀리면 자동으로 되살린다. 삼바 브라우저의 하네스 브릿지(레인)로 돈다.

## 쓰는 법
```
node keeper.mjs once  [--site ID] [--dry]   한 번 점검(--dry 는 복구 안 함)
node keeper.mjs watch [--interval 15]        계속 점검(기본 15분 ±2분)
node keeper.mjs status                       마지막 점검 결과
node keeper.mjs test-relogin --site ID       (시험) 로그아웃 → 복구 → 재확인
```
앱(삼바 브라우저)이 켜져 있고 브릿지가 켜져 있어야 한다. 꺼져 있으면 기다린다.
상태·로그: `%APPDATA%\SAMBA Browser\session-keeper\` (`state.json`, `keeper.log`)

## 원칙
- 비밀번호를 입력하지 않는다. 클릭·주소 이동뿐이다. 아이디/비밀번호 로그인은 앱의 `login` 도구가 키마스터에서 꺼내 입력한다.
- 판정 불가면 아무것도 하지 않는다. 판정은 요소 이름이 정확히 같을 때만 맞는다(`sites.json` markers).
- 네이버가 로그아웃이면 네이버 소셜 사이트 복구를 시도하지 않고 "네이버 필요"로 알린다.
- 사이트마다 하루 시도 한도(6)·최소 간격(30분)·연속 실패(3회) 시 6시간 중단.
- 점검·복구는 레인 탭으로 돈다 — 사람이 쓰는 탭, 앱 화면(설정 등)과 무관하다.

## 복구 전략
| type | 동작 | 쓰는 곳 |
|---|---|---|
| `naver_direct` | 간편로그인 창 주소를 탭에서 바로 연다 | ABC마트·그랜드스테이지(`a-rt.com`) |
| `naver_click` | 로그인 페이지에서 "네이버" 버튼을 누른다(팝업 포함) | SSG, 롯데ON |
| `vault_login` | 앱의 `login` 도구(키마스터 계정 입력) | 무신사 |

## 사이트 추가
`sites.json` 에 `id`, `home`, `markers`(in=로그인 표시, out=로그아웃 표시), `relogin` 을 넣는다.
표식은 실제 화면에서 `find_elements` 로 확인한다(요소 이름이 정확히 같아야 한다).

## 알아 둔 함정(실측 2026-10-04)
- 앱이 설정 화면을 보는 동안 레인이 아닌 새 탭은 크기 0 으로 접혀 응답하지 않는다 → 반드시 레인으로 연다.
- 롯데ON·SSG 는 홈이 느리게 떠서 25초를 넘길 수 있다 → 판정 불가면 한 번 더 확인하고, 그래도 불가면 건드리지 않는다.
- `find_elements` 는 부분일치라 페이지 전체를 감싼 긴 clickable 이 같이 나온다 → 버튼·링크 중 이름이 짧은 것을 고른다.
- `login` 도구의 정상 응답 `submitted: check the page for success or captcha/2FA` 에 captcha 가 들어 있다 → 글자로 오판하지 말고 재확인으로 가린다.
