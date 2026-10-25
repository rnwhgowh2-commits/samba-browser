# 하네스 브릿지

SAMBA Browser 의 에이전트 도구를 로컬 HTTP 로 연다. 밖의 LangGraph 하네스(감독자·전문 에이전트)가 손발로 쓴다.

- 켜기: 설정 → 동작 → 하네스 브릿지. 포트 기본 47811, 토큰은 켤 때 자동 생성(복사 버튼, 새로 만들기).
- 바인딩: 127.0.0.1 만. 외부 접근 불가.
- 인증: 헤더 `X-Samba-Token`. 없거나 틀리면 401.

## 규약

- `GET /health` → `{ ok, tools[] }`
- `POST /tool/{name}` 본문 `{ "args": {...} }` → `{ ok, result, steps[] }`
  - `result` 는 채팅 AI 가 보는 것과 같은 도구 본문 문자열
  - `steps` 는 그 호출이 남긴 진행 로그(라벨·성공 여부)
- 오류: 401 토큰 / 404 없는 도구 / 400 JSON 아님·본문 오류 / 409 채팅 실행 중·다른 호출 중 / 504 90초 초과 / 413 본문 1MB 초과 / 500 도구 오류
- 제한 시간을 넘긴 호출은 504 로 답한 뒤에도 끝날 때까지 지켜보고, 그동안 새 호출은 409 다.

## 도구 이름

채팅 AI 와 동일: get_page, find_elements, screenshot, ocr, navigate, click, type, select, scroll,
dismiss_overlay, run_js, wait, new_tab, list_tabs, switch_tab, close_tab, list_accounts,
fill_secret, login, progress, remember_site, save_script, run_script, list_playbooks, update_playbook,
phone_*(폰 연결 시), phone_approve_payment(결제 배선 시). `done` 은 없다.

### 사이트 계정 등록·기존 로그인 연결

`register_site_account`는 현재 탭의 사이트를 실제 키마스터 계정으로 등록한다. `siteName`과 `username`이면 비밀번호 없는 세션용 계정을 만든다. `sourceHost`와 정확한 `sourceAccountLabel`, `loginMethod: "naver"`를 함께 주면 네이버 간편로그인으로 연결한다. `login`은 같은 프로필의 기존 네이버 세션과 공식몰의 네이버 버튼을 사용하며 공식몰 비밀번호 칸에 네이버 비밀번호를 넣지 않는다. 외부 사이트 회원가입·구매·클레임 접수는 별도 요청에 따른다.

연결은 원본 도메인·아이디와 로그인 방식으로 저장한다. 원본의 결제 비밀번호·카드·세션 쿠키는 복제하지 않는다. 네이버 연결에서 `fill_secret`은 로그인 비밀번호를 반환하거나 채우지 않는다. 제외 사이트·접근 금지·다른 작업공간·삭제된 원본·기존 직접 로그인 덮어쓰기는 거부한다. 같은 원본의 연결 방식은 변경할 수 있다. `shared_password`(생략 시 기본값)는 사용자가 같은 비밀번호 사용을 명시한 경우에만 사용한다.

예: 르무통 탭에서 `{ "siteName": "르무통 공식몰", "sourceHost": "naver.com", "sourceAccountLabel": "<사용자가 지정한 저장 계정 라벨>", "loginMethod": "naver" }`. 응답에는 연결 결과와 계정 메타만 담긴다. 비밀번호 인자는 없다.

외부 MCP 어댑터의 도구 목록은 `node tools/install-account-tool.mjs`로 갱신한다. 메인 프로세스 변경을 적용하려면 실행 중 작업이 없는 시점에 앱을 정상 종료하고 다시 시작한다.

## 하네스 .env

```
SAMBA_BRIDGE_URL=http://127.0.0.1:47811
SAMBA_BRIDGE_TOKEN=<설정 카드에서 복사한 토큰>
```

## 주의

- 브릿지 호출 중에는 채팅창 AI 실행이 거부된다(한 손발). 반대도 같다.
- 확인 카드는 뜨지 않는다(판단은 하네스가 한다). 캡차·2단계 인증은 도구가 `needs_user` 문자열을 돌려주니 하네스가 사람에게 넘긴다.
- 응답에 비밀값(비밀번호·키패드 값)은 없다 — 도구가 애초에 돌려주지 않는다.
- **브릿지를 켜면, 토큰을 쥔 하네스는 설정의 권한 모드(읽기 전용/가드/전체)와 무관하게 항상 전체 권한으로 동작한다.** 확인 카드가 뜨지 않으므로 클릭·입력·로그인·결제 비밀번호 입력까지 사람 개입 없이 그대로 실행된다. 토큰이 새어나가면 곧 이 PC 전체 권한이 새어나가는 것과 같다 — 토큰 보관에 주의한다. 설정의 권한 모드가 읽기 전용이면 브릿지 세션 자체를 열 수 없다(`createToolSession` 이 거부한다).

## 확인(curl)

```
curl -s -H "X-Samba-Token: <토큰>" http://127.0.0.1:47811/health
curl -s -X POST -H "X-Samba-Token: <토큰>" -H "content-type: application/json" -d "{\"args\":{}}" http://127.0.0.1:47811/tool/list_tabs
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:47811/health   # 401
```
