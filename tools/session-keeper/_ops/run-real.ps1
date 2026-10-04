# 사용: powershell -File run-real.ps1 <스크립트.ps1> <결과파일> [최대대기초]
# 작업 스케줄러(가상 폴더 밖 = 실제 컨텍스트)로 스크립트를 한 번 실행하고, 결과 파일에 DONE/ABORT/ERROR/EXCEPTION 이 생길 때까지 기다린다.
param([string]$Script, [string]$Result, [int]$MaxSec = 300)
$tn = 'SAMBA_tmp_real_run_' + [guid]::NewGuid().ToString('N').Substring(0,8)
Remove-Item $Result -ErrorAction SilentlyContinue
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Script`""
Register-ScheduledTask -TaskName $tn -Action $act -Force | Out-Null
Start-ScheduledTask -TaskName $tn
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt $MaxSec) {
  Start-Sleep -Seconds 2
  if ((Test-Path $Result) -and ((Get-Content $Result -Raw -Encoding UTF8) -match 'DONE|ABORT|ERROR|EXCEPTION')) { break }
}
Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path $Result) { Get-Content $Result -Encoding UTF8 } else { '(결과 파일 없음 — 시간 초과)' }
