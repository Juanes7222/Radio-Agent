Option Explicit

Dim shell
Dim fso
Dim currentDir

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = currentDir

shell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| find "":3000"" ^| find ""LISTENING""') do taskkill /PID %a /F", 0, True

WScript.Sleep 1500

shell.Run "cmd /c node src\index.js", 0, False