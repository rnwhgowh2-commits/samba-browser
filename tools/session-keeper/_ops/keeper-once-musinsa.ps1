$res = 'C:\Users\rnwhg\Desktop\samba-work\keeper-once.result.txt'
try {
  $env:KEEPER_STDOUT = '1'
  $o = & 'C:\Program Files\nodejs\node.exe' 'C:\Users\rnwhg\Desktop\samba-browser\tools\session-keeper\keeper.mjs' once --site MUSINSA 2>&1 | Out-String
  $o | Out-File $res -Encoding utf8
  'DONE' | Out-File $res -Append -Encoding utf8
} catch { "EXCEPTION $_" | Out-File $res -Encoding utf8 }
