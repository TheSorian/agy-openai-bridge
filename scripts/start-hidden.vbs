' agy-openai-bridge: starts the supervisor with no console window.
'
' Invoked by the scheduled task (wscript is a GUI host, so it never creates a console, and the
' window style 0 below hides the one node would otherwise get). The path is resolved from this
' file, so the repository can live anywhere.
Option Explicit

Dim sh, fso, root, nodePath, script
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
script = root & "\scripts\supervise.mjs"

nodePath = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If Not fso.FileExists(nodePath) Then nodePath = "node"

' 0 = hidden window, False = do not wait for it to finish.
sh.Run """" & nodePath & """ """ & script & """ --start", 0, False
