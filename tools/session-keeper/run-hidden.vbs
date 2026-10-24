' 세션 관리자를 콘솔 창 없이 띄운다(작업 스케줄러가 부른다). 창이 깜빡이지 않게 wscript 로 숨김 실행한다.
' 표준 출력·오류는 session-keeper 데이터 폴더의 stdio.txt 에 남긴다(문제 진단용).
Dim sh, fso, here, dataDir, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
dataDir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\SAMBA Browser\session-keeper"
If Not fso.FolderExists(dataDir) Then
  On Error Resume Next
  fso.CreateFolder sh.ExpandEnvironmentStrings("%APPDATA%") & "\SAMBA Browser"
  fso.CreateFolder dataDir
  On Error GoTo 0
End If
cmd = "cmd.exe /c """"C:\Program Files\nodejs\node.exe"" """ & here & "\keeper.mjs"" watch --interval 10 >> """ & dataDir & "\stdio.txt"" 2>&1"""
sh.CurrentDirectory = here
sh.Run cmd, 0, False
