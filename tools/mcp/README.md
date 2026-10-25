# 삼바브라우저 MCP 설치

브라우저와 MCP 서버를 같은 저장소에서 버전 관리한다. `server.mjs`와 `tools.json`은 기존에 사용자 폴더에서 실행하던 어댑터·명세의 소스다. Node.js 20 이상과 Python 3.11 이상이 필요하고, MCP 자체는 외부 패키지가 필요 없다.

새 PC에서 브라우저 저장소를 받은 뒤 PowerShell에서 한 번 실행한다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-mcp.ps1 -StartBrowser
```

의존성 설치 → 브라우저 빌드 → 이 PC의 절대 경로로 Claude Code와 Codex 모두 MCP 등록 → 브라우저 실행 요청 순서다. 기존 설치에서 빌드를 생략하고 등록만 갱신하려면 `-SkipBuild`를 붙인다. 설치를 반복해도 같은 MCP 항목이 중복되지 않는다. 설치 후에는 각 클라이언트의 MCP 다시 연결 또는 새 세션이 필요하다. 브라우저가 실행 중이어야 실제 도구를 사용할 수 있다.

설치기는 Codex의 `~/.codex/config.toml`과 Claude Code의 `~/.claude.json`에 있는 `samba-browser` 항목만 갱신한다. Claude Code는 모든 프로젝트에서 쓸 수 있는 사용자 범위다. `CODEX_HOME`과 `CLAUDE_CONFIG_DIR`도 지원하며, Claude 설정 파일은 `--claude-config`로 직접 지정할 수 있다. 기존 설정을 백업하고 다른 서버·REA·프로젝트·계정 설정을 보존한다. 기존 앱 설정·토큰은 바꾸지 않는다. 첫 설치라 앱 설정이 없을 때만 로컬 브릿지와 임의 토큰을 생성한다. 기존 앱에서 브릿지를 꺼 뒀다면 설정 → 동작 → 하네스 브릿지에서 켠다. 실행 중인 프로세스는 종료하지 않는다.

```powershell
# 설정을 바꾸지 않는 연결 검사: 두 클라이언트 등록 + 브릿지 인증 + MCP initialize/tools/list/ping
powershell -ExecutionPolicy Bypass -File .\scripts\setup-mcp.ps1 -Check

# 사용자 지정 앱 데이터 경로
python .\tools\mcp\setup.py --app-config 'D:\SambaData\config.json'
```

브릿지 토큰은 도구를 호출할 때마다 로컬 앱 설정에서 읽는다. GitHub에는 서버 소스·도구 명세·설치기만 올리고 `.env`, 앱 데이터, 로그인 세션, 키마스터, Codex 사용자 설정은 올리지 않는다. `tools.json`은 도구 정의만 담는다. 앱 도구가 추가되면 이 명세도 함께 갱신한다.

삼바웨이브와 함께 설치하는 절차는 삼바웨이브 저장소의 `docs/samba-browser-set.md`와 `tools/setup-samba-set.ps1`을 따른다. 두 저장소는 같은 상위 폴더에 둘 수 있다.

설정 형식 근거: [Codex 공식 MCP 문서](https://developers.openai.com/codex/mcp), [Claude Code 공식 MCP 문서](https://code.claude.com/docs/en/mcp). Claude Desktop의 일반 채팅 설정과 Claude Code의 MCP 등록은 별개이며 이 설치기는 Claude Code를 대상으로 한다.
