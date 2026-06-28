# Sets up autostart for the device battery service: a hidden shortcut in the
# user's Startup folder that launches start.vbs at every logon (no window).
# Requires NO administrator rights. Idempotent.
#
# Install:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Remove:   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove

param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$serviceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs        = Join-Path $serviceDir 'start.vbs'
$startup    = [Environment]::GetFolderPath('Startup')
$lnk        = Join-Path $startup 'Device Battery Service.lnk'

if ($Remove) {
  if (Test-Path $lnk) {
    Remove-Item $lnk -Force
    Write-Host "Autostart shortcut removed: $lnk"
  } else {
    Write-Host "No autostart shortcut found."
  }
  return
}

if (-not (Test-Path $vbs)) {
  throw "start.vbs not found at: $vbs"
}

$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath       = 'wscript.exe'
$shortcut.Arguments        = '"' + $vbs + '"'
$shortcut.WorkingDirectory = $serviceDir
$shortcut.WindowStyle      = 7
$shortcut.Description       = 'Starts the device battery service (HyperX / Switch Pro / G502) at logon.'
$shortcut.Save()

Write-Host "Autostart shortcut created: $lnk"
Write-Host "Start it now with:  wscript.exe `"$vbs`""
