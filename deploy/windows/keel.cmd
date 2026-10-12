@echo off
rem Keel command for Windows: runs keel-cli.ps1 next to this file, whatever
rem the PowerShell execution policy. Usage: keel help
rem PowerShell by its full path: cmd.exe looks in the current folder first, so
rem a bare powershell.exe could run a program from the folder you're in.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0keel-cli.ps1" %*
exit /b %ERRORLEVEL%
