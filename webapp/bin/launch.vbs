' Shortcut target for the installed Kenshi MKII Editor.
' Runs bin\launcher.js through the bundled node.exe with no console window and
' reports the launcher's exit code as a message box.
' Keep this file ASCII-only: cscript reads it under the system codepage.
Option Explicit
Dim shell, fso, scriptDir, nodeExe, launcher, cmd, exitCode, message
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = """" & scriptDir & "\node.exe" & """"
launcher = """" & scriptDir & "\launcher.js" & """"
cmd = nodeExe & " " & launcher
exitCode = shell.Run(cmd, 0, True)
If exitCode <> 0 Then
  Select Case exitCode
    Case 2
      message = "The editor did not become ready in time. Try launching it again."
    Case 3
      message = "Port 3080 is already in use by another application. Close it, then launch the editor again."
    Case 4
      message = "The editor could not safely stop its installed server process."
    Case Else
      message = "Kenshi MKII Editor could not start (error " & exitCode & ")."
  End Select
  shell.Popup message, 0, "Kenshi MKII Editor", 16
End If
Set fso = Nothing
Set shell = Nothing
