' Starts the battery service without showing a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
serviceDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = serviceDir
shell.Run "node service.js", 0, False
