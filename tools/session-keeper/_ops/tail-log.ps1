[Console]::OutputEncoding=[Text.Encoding]::UTF8
$out='C:\Users\rnwhg\Desktop\_log.txt'
$f=Join-Path $env:APPDATA 'SAMBA Browser\session-keeper\keeper.log'
$o=@(); if(Test-Path $f){ $o += (Get-Content $f -Tail 400 -Encoding UTF8 | Select-String '동기화|삼바' | Select-Object -Last 6 | ForEach-Object { $_.Line }) } else { $o += 'keeper.log 없음' }
$o += 'DONE'; $o | Set-Content $out -Encoding UTF8
