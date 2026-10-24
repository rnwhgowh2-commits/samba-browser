@echo off
rem Samba settings-tab accounts -> SAMBA Browser keymaster, then restart the session keeper with the new code
cd /d "%~dp0.."
set KEEPER_STDOUT=1
set OUT=C:\Users\rnwhg\samba-browser-backup\sync-result.txt
echo [1/2] sync %DATE% %TIME% > "%OUT%"
"C:\Program Files\nodejs\node.exe" keeper.mjs sync-samba >> "%OUT%" 2>&1
echo [2/2] restart keeper >> "%OUT%"
for /f "usebackq delims=" %%p in ("%APPDATA%\SAMBA Browser\session-keeper\watch.lock") do taskkill /PID %%p /F >> "%OUT%" 2>&1
timeout /t 2 /nobreak >nul
wscript "%~dp0..\run-hidden.vbs"
echo DONE >> "%OUT%"
