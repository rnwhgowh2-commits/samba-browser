# 삼바 백엔드 .env 에 CS_INTERNAL_TOKEN(내부 API 토큰)이 없으면 난수로 한 줄 추가한다. 값은 화면에 출력하지 않는다.
param([string]$EnvFile = 'C:\Users\rnwhg\Desktop\samba-wave-main\backend\.env')
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $EnvFile)) { throw ".env 를 찾지 못함: $EnvFile" }
$text = [IO.File]::ReadAllText($EnvFile)
if ($text -match '(?m)^[ \t]*CS_INTERNAL_TOKEN[ \t]*=[ \t]*\S') { Write-Host '이미 CS_INTERNAL_TOKEN 이 설정돼 있습니다. 바꾸지 않았습니다.'; return }
$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
$prefix = if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $nl } else { '' }
# 이전 줄 중 빈 CS_INTERNAL_TOKEN= 이 있으면 그 줄을 대체한다
$text = [regex]::Replace($text, '(?m)^[ \t]*CS_INTERNAL_TOKEN[ \t]*=[ \t]*\r?$\n?', '')
[IO.File]::WriteAllText($EnvFile, $text + $prefix + 'CS_INTERNAL_TOKEN=' + $token + $nl, (New-Object Text.UTF8Encoding($false)))
Write-Host '설정했습니다. 삼바 백엔드가 다음에 새로 시작될 때 적용됩니다(중앙 반영 절차의 교대 때).'
