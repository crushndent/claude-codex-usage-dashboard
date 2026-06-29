' Start the dashboard server in the background without a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
sh.Run "node """ & folder & "\server.js""", 0, False
