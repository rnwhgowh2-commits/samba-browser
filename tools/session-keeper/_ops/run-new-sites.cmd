@echo off
rem One supervised pass over the newly added sites (waits for any running check via check.lock)
cd /d "%~dp0.."
set OUT=C:\Users\rnwhg\samba-browser-backup\run-new-sites.txt
echo start %DATE% %TIME% > "%OUT%"
for %%s in (GSShop LOTTEIMALL FashionPlus HMALL TheHyundai SSF GALLERIAMALL GMARKET LFmall NAVERSTORE) do (
  echo === %%s >> "%OUT%"
  "C:\Program Files\nodejs\node.exe" keeper.mjs once --site %%s >> "%OUT%" 2>&1
)
echo DONE %DATE% %TIME% >> "%OUT%"
