# 삼바웨이브에 저장된 소싱처 계정을 삼바 브라우저 키마스터 '비밀번호 CSV 가져오기' 형식으로 내보낸다.
# - 사용자가 직접 실행한다. 비밀번호가 담긴 CSV 는 바탕화면에 만들어지고, 가져오기가 끝나면 반드시 삭제한다.
# - 이 PC 의 삼바 백엔드 설정(backend\.env 의 READ_DB_*)으로 읽기 전용 조회만 한다.
# 사용: powershell -File export-from-samba.ps1 [-Sites MUSINSA,SSG] [-Dry]
#   -Dry : 비밀번호 대신 길이만 넣고 파일을 만들지 않으며 건수만 출력한다(점검용)
param([string[]]$Sites = @('MUSINSA'), [switch]$Dry)
$ErrorActionPreference = 'Stop'
$Sites = @($Sites | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$envFile = 'C:\Users\rnwhg\Desktop\samba-wave-main\backend\.env'
$psql = 'C:\Program Files\PostgreSQL\16\bin\psql.exe'
if (-not (Test-Path $psql)) { throw "psql 을 찾지 못함: $psql" }
$kv = @{}
foreach ($l in Get-Content $envFile -Encoding UTF8) {
  if ($l -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $kv[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
}
foreach ($k in 'READ_DB_HOST','READ_DB_PORT','READ_DB_USER','READ_DB_PASSWORD','READ_DB_NAME') { if (-not $kv[$k]) { throw "backend\.env 에 $k 가 없음" } }
$env:PGPASSWORD = $kv['READ_DB_PASSWORD']
$env:PGCLIENTENCODING = 'UTF8'

# 사이트별 로그인 주소(가져오기 시 사이트 도메인 판별에 쓰인다)
$urlCase = "case site_name
  when 'MUSINSA' then 'https://www.musinsa.com/auth/login'
  when 'SSG' then 'https://member.ssg.com/member/login.ssg'
  when 'LOTTEON' then 'https://www.lotteon.com/p/member/login/common'
  when 'ABCmart' then 'https://www.a-rt.com/login'
  when '29CM' then 'https://www.29cm.co.kr/login'
  when 'GSShop' then 'https://www.gsshop.com/member/login.gs'
  when 'FashionPlus' then 'https://www.fashionplus.co.kr/login'
  when 'LOTTEIMALL' then 'https://www.lotteimall.com/member/login/forward.lotte'
  when 'NAVERSTORE' then 'https://nid.naver.com/nidlogin.login'
  else '' end"
$inList = ($Sites | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
$pwExpr = if ($Dry) { "length(password)::text" } else { "password" }
$sql = "select site_name || ' ' || account_label as name, ($urlCase) as url, username, $pwExpr as password, '' as note
from samba_sourcing_account
where is_active and site_name in ($inList) and coalesce(username,'')<>'' and coalesce(password,'')<>''
order by site_name, account_label"
$conn = @('-h', $kv['READ_DB_HOST'], '-p', $kv['READ_DB_PORT'], '-U', $kv['READ_DB_USER'], '-d', $kv['READ_DB_NAME'], '-X')

if ($Dry) {
  $n = "select count(*) from ($sql) q" | & $psql @conn -A -t
  Write-Host "대상 계정 수(아이디·비밀번호가 모두 있는 활성 계정): $n"
  $per = "select site_name, count(*) from samba_sourcing_account where is_active and site_name in ($inList) and coalesce(username,'')<>'' and coalesce(password,'')<>'' group by 1 order by 1" | & $psql @conn -A -t -F ' : '
  $per | ForEach-Object { Write-Host "  $_" }
  return
}

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) '삼바_계정_가져오기.csv'
$tmp = Join-Path $env:TEMP ('samba-export-' + [guid]::NewGuid().ToString('N') + '.csv')
try {
  ("\copy (" + ($sql -replace "\r?\n"," ") + ") to '$tmp' with (format csv, header true)") | & $psql @conn | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'psql 내보내기 실패' }
  $text = [IO.File]::ReadAllText($tmp, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding($true)))
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
$rows = (Import-Csv $out -Encoding UTF8 | Measure-Object).Count
Write-Host "내보냈습니다: $out ($rows 개 계정)"
Write-Host '삼바 브라우저 설정 → 키마스터 → 가져오기 → 비밀번호 CSV 로 가져온 뒤, 이 파일을 반드시 삭제하세요(평문 비밀번호).'
