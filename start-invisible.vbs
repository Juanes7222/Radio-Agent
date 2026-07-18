Option Explicit

Dim shell
Dim fso
Dim currentDir
Dim exitCode
Dim retries

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = currentDir

retries = 0

Do
    exitCode = shell.Run("cmd /c node src\index.js", 0, True)

    If exitCode = 0 Then Exit Do

    retries = retries + 1

    If retries >= 10 Then Exit Do

    WScript.Sleep 2000
Loop