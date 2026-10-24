$res = 'C:\Users\rnwhg\Desktop\samba-work\restart-app.result.txt'
try {
  $root = 'C:\Users\rnwhg\Desktop\samba-browser'
  $exe = Join-Path $root 'node_modules\.pnpm\electron@39.8.10\node_modules\electron\dist\electron.exe'
  $log = @()
  # 삼바 브라우저 앱 메인 프로세스 = 같은 electron.exe 중 하위 프로세스(--type=)가 아니고 앱 폴더를 인자로 받은 것.
  # 같은 electron.exe 를 쓰는 다른 프로그램(하네스·시험 등)은 건드리지 않는다
  function Get-AppMains {
    @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type=' -and
      ($_.CommandLine -replace '"','').TrimEnd() -like "*$root"
    })
  }
  function Get-Descendants($ids) {
    $all = @(Get-CimInstance Win32_Process)
    $out = @(); $queue = @($ids)
    while ($queue.Count -gt 0) {
      $next = @()
      foreach ($pid1 in $queue) { foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $pid1 })) { $out += $c.ProcessId; $next += $c.ProcessId } }
      $queue = $next
    }
    $out
  }
  $old = Get-AppMains
  $oldIds = @($old | ForEach-Object { $_.ProcessId })
  $log += "앱 메인 프로세스 $($oldIds -join ',')"
  foreach ($id in $oldIds) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { [void]$p.CloseMainWindow() }
  }
  # 옛 메인 프로세스가 끝날 때까지 최대 60초 기다린다(세션 관리자가 앱을 곧바로 다시 켜므로 '전체 0'을 기다리지 않는다)
  $t0 = Get-Date
  $alive = $oldIds
  while (((Get-Date) - $t0).TotalSeconds -lt 60) {
    $alive = @($oldIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  $secs = [int]((Get-Date) - $t0).TotalSeconds
  if ($alive.Count -gt 0) {
    $log += "정상 종료가 ${secs}초 안에 끝나지 않아 옛 앱($($alive -join ','))만 강제 종료"
    $kill = @($alive) + @(Get-Descendants $alive)
    $kill | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
  } else {
    $log += "정상 종료 완료(${secs}초, 강제 종료 없음)"
  }
  Start-Sleep -Seconds 6
  $new = @(Get-AppMains | Where-Object { $oldIds -notcontains $_.ProcessId })
  if ($new.Count -eq 0) {
    Start-Process -FilePath $exe -ArgumentList ('"' + $root + '"') -WorkingDirectory $root
    $log += '다른 곳이 다시 켜지 않아 직접 시작'
    Start-Sleep -Seconds 10
    $new = @(Get-AppMains | Where-Object { $oldIds -notcontains $_.ProcessId })
  } else {
    $log += '세션 관리자 등이 이미 다시 켬'
  }
  $log += "새 앱 메인 $(($new | ForEach-Object { $_.ProcessId }) -join ',')"
  $log | Out-File $res -Encoding utf8
  'DONE' | Out-File $res -Append -Encoding utf8
} catch { "EXCEPTION $_" | Out-File $res -Encoding utf8 }
