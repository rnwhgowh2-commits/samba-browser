# 저장소를 받은 PC의 경로로 앱 준비와 Codex MCP 등록을 수행한다.
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$StartBrowser,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$setup = Join-Path $root 'tools\mcp\setup.py'
Get-Command node, python -ErrorAction Stop | Out-Null
if ($Check) {
    & python $setup --check
    if ($LASTEXITCODE -ne 0) { throw 'MCP 연결 검사에 실패했습니다.' }
    return
}
if (-not $SkipBuild) {
    Get-Command pnpm -ErrorAction Stop | Out-Null
    Push-Location $root
    try {
        & pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw '의존성 설치에 실패했습니다.' }
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw '브라우저 빌드에 실패했습니다.' }
    } finally { Pop-Location }
}
& python $setup
if ($LASTEXITCODE -ne 0) { throw 'MCP 등록에 실패했습니다.' }
if ($StartBrowser) {
    $electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
    $built = Join-Path $root 'out\main\index.js'
    if (-not (Test-Path -LiteralPath $electron) -or -not (Test-Path -LiteralPath $built)) {
        throw '실행 파일이 없습니다. -SkipBuild 없이 다시 설치하세요.'
    }
    Start-Process -FilePath $electron -ArgumentList ('"' + $root + '"') -WorkingDirectory $root -WindowStyle Hidden
    Write-Host '브라우저 실행을 요청했습니다. Codex MCP를 다시 연결하거나 새 채팅을 여세요.'
}
