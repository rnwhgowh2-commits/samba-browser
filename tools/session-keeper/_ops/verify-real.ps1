# 실제 컨텍스트에서 확인: 앱이 실제 폴더를 쓰는지, 세션 관리자 점검이 앱에 닿는지. 값은 출력하지 않는다.
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$out = 'C:\Users\rnwhg\Desktop\_verify-result.txt'
$log = New-Object System.Collections.Generic.List[string]
function L($m){ $log.Add($m); $log | Set-Content -Path $out -Encoding UTF8 }
try {
  $real = Join-Path $env:APPDATA 'SAMBA Browser'
  L "실제 폴더 최근 변경 파일(상위 6):"
  Get-ChildItem $real -File -Force | Sort-Object LastWriteTime -Descending | Select-Object -First 6 | ForEach-Object { L ("  {0,-26} {1}" -f $_.Name, $_.LastWriteTime.ToString('HH:mm:ss')) }
  L ("lockfile 존재: " + (Test-Path (Join-Path $real 'lockfile')))
  L ("현재 시각: " + (Get-Date).ToString('HH:mm:ss'))
  $c = Get-Content (Join-Path $real 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  L "config: bridgeEnabled=$($c.bridgeEnabled) tokenLen=$(([string]$c.bridgeToken).Length)"
  # 세션 관리자 점검(복구 없이)
  $env:KEEPER_STDOUT = '1'
  $o = & 'C:\Program Files\nodejs\node.exe' 'C:\Users\rnwhg\Desktop\samba-browser\tools\session-keeper\keeper.mjs' once 2>&1 | Out-String
  L "--- keeper once(복구 포함) ---"
  L $o
  L 'DONE'
} catch { L ("EXCEPTION: " + $_.Exception.Message) }
