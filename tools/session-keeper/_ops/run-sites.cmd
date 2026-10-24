@echo off
rem Run one check pass for the site ids listed in samba-browser-backup\run-sites.txt
cd /d "%~dp0.."
set OUT=C:\Users\rnwhg\samba-browser-backup\run-sites.result.txt
echo start %DATE% %TIME% > "%OUT%"
for /f "usebackq delims=" %%s in ("C:\Users\rnwhg\samba-browser-backup\run-sites.txt") do (
  echo === %%s >> "%OUT%"
  "C:\Program Files\nodejs\node.exe" keeper.mjs once --site %%s >nul 2>&1
)
echo DONE %DATE% %TIME% >> "%OUT%"
