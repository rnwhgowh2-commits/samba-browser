$res = 'C:\Users\rnwhg\Desktop\samba-work\login-harness-profile.result.txt'
try {
  $o = & 'C:\Program Files\nodejs\node.exe' 'C:\Users\rnwhg\Desktop\samba-browser\tools\session-keeper\_ops\login-harness-profile.mjs' '무신사_rnwhgowh' 2>&1 | Out-String
  $o | Out-File $res -Encoding utf8
} catch { "EXCEPTION $_" | Out-File $res -Encoding utf8 }
