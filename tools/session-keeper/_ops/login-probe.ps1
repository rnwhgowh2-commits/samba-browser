$res = 'C:\Users\rnwhg\Desktop\samba-work\login-probe.result.txt'
try {
  $o = & 'C:\Program Files\nodejs\node.exe' 'C:\Users\rnwhg\Desktop\samba-browser\tools\session-keeper\_ops\login-probe.mjs' '무신사_rnwhgowh' 'https://www.musinsa.com/' 'https://www.musinsa.com/mypage' 'https://www.musinsa.com/main/musinsa/recommend?gf=A' 2>&1 | Out-String
  $o | Out-File $res -Encoding utf8
} catch { "EXCEPTION $_" | Out-File $res -Encoding utf8 }
