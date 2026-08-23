Option Explicit

Dim shell, fso, runtimeRoot, installRoot, powershell, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

runtimeRoot = fso.GetParentFolderName(WScript.ScriptFullName)
installRoot = fso.GetParentFolderName(runtimeRoot)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
launcher = runtimeRoot & "\run-gateway.ps1"
command = Chr(34) & powershell & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & launcher & Chr(34) & " -InstallRoot " & Chr(34) & installRoot & Chr(34)

' WScript runs in the GUI subsystem with no console window. Window style 0
' keeps the child Windows PowerShell host hidden as well.
shell.Run command, 0, False
