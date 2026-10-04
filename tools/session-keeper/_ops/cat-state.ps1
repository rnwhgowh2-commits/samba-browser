# 실제 컨텍스트에서 세션 관리자 상태(state.json)를 읽어 요약만 Desktop\_state.txt 에 쓴다. 쿠키·비밀번호는 없다.
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$out='C:\Users\rnwhg\Desktop\_state.txt'
$f = Join-Path $env:APPDATA 'SAMBA Browser\session-keeper\state.json'
$o = New-Object System.Collections.Generic.List[string]
if (Test-Path $f) {
  $s = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($k in $s.sites.PSObject.Properties.Name) {
    $x = $s.sites.$k
    $ago = if ($x.checkedAt) { [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $x.checkedAt)/60000) } else { -1 }
    $o.Add("$k|$($x.status)|점검 ${ago}분 전|24h복구 $(@($x.attempts).Count)|실패 $($x.fails)|$($x.detail)")
  }
} else { $o.Add('state.json 없음') }
$o.Add('DONE')
$o | Set-Content -Path $out -Encoding UTF8
