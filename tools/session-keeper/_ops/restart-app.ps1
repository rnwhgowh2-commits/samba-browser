$res = 'C:\Users\rnwhg\Desktop\samba-work\restart-app.result.txt'
try {
  $root = 'C:\Users\rnwhg\Desktop\samba-browser'
  $exe = Join-Path $root 'node_modules\.pnpm\electron@39.8.10\node_modules\electron\dist\electron.exe'
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
  $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe }).Count
  Start-Process -FilePath $exe -ArgumentList ('"' + $root + '"') -WorkingDirectory $root
  Start-Sleep -Seconds 12
  $now = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe }).Count
  "남은 옛 프로세스 $left / 새 프로세스 $now" | Out-File $res -Encoding utf8
  'DONE' | Out-File $res -Append -Encoding utf8
} catch { "EXCEPTION $_" | Out-File $res -Encoding utf8 }
