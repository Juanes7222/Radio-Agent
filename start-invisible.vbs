Option Explicit

' Single supervisor for the agent. It is the only place where node is started:
' any other script must go through this one, otherwise two copies race for
' port 3000 and the loser logs EADDRINUSE on every retry.

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
    ' Another copy already owns the port, so starting one would only fail.
    ' Wait for it to go away instead of burning the retry budget.
    Do While PortIsTaken()
        WScript.Sleep 5000
    Loop

    exitCode = shell.Run("cmd /c node src\index.js", 0, True)

    If exitCode = 0 Then Exit Do

    retries = retries + 1

    If retries >= 10 Then Exit Do

    WScript.Sleep 2000
Loop

Function PortIsTaken()
    Dim exec
    Dim line
    Dim netstat

    PortIsTaken = False

    netstat = "cmd /c netstat -ano -p tcp | %SystemRoot%\System32\findstr.exe LISTENING | %SystemRoot%\System32\findstr.exe "":3000 """
    Set exec = shell.Exec(netstat)

    Do While Not exec.StdOut.AtEndOfStream
        line = exec.StdOut.ReadLine()
        If InStr(line, ":3000 ") > 0 Then
            PortIsTaken = True
            Exit Do
        End If
    Loop
End Function
