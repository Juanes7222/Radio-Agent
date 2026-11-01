Option Explicit

' Restart helper. start-invisible.vbs is the only launcher, so this script kills
' the running agent and waits for that supervisor to start a fresh copy. It must
' never run node itself: doing that and letting the supervisor do the same is
' what put two copies on port 3000 and filled app.log with EADDRINUSE.

Dim shell
Dim fso
Dim currentDir
Dim waited
Dim killCommand

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = currentDir

killCommand = "cmd /c for /f ""tokens=5"" %a in ('netstat -ano -p tcp ^| %SystemRoot%\System32\findstr.exe LISTENING ^| %SystemRoot%\System32\findstr.exe "":3000 ""') do taskkill /PID %a /F"
shell.Run killCommand, 0, True

waited = 0
Do While waited < 20 And Not PortIsTaken()
    WScript.Sleep 1000
    waited = waited + 1
Loop

If Not PortIsTaken() Then
    ' Nobody was supervising the agent, so start the supervisor.
    shell.Run "wscript.exe """ & currentDir & "\start-invisible.vbs""", 0, False
End If

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
