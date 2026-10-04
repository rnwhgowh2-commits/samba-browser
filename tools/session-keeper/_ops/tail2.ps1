[Console]::OutputEncoding=[Text.Encoding]::UTF8
$f=Join-Path $env:APPDATA 'SAMBA Browser\session-keeper\keeper.log'
$o=(Get-Content $f -Tail 14 -Encoding UTF8); $o += 'DONE'; $o | Set-Content 'C:\Users\rnwhg\Desktop\_log.txt' -Encoding UTF8
