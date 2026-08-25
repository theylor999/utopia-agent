<#
.SYNOPSIS
  Installs the locally built Utopia Agent as a real Windows app.

.DESCRIPTION
  Copies the release binary out of the build tree into
  %LOCALAPPDATA%\UtopiaAgent, so the app no longer depends on the repo
  being present, then creates the Desktop and Start Menu shortcuts and the
  `utopia-agent` CLI shim.

  Windows 11 does not expose taskbar pinning to scripts, so the last step
  (right click the taskbar button -> "Pin to taskbar") stays manual.

.EXAMPLE
  npm run tauri build
  powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'UtopiaAgent')
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$release = Join-Path $repo 'src-tauri\target\release'

$exe = Get-ChildItem -Path $release -Filter '*.exe' -File |
  Where-Object { $_.Name -match '^(utopia-agent|Utopia Agent)\.exe$' } |
  Select-Object -First 1
if (-not $exe) {
  throw "No release binary in $release. Run `npm run tauri build` first."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$target = Join-Path $InstallDir 'UtopiaAgent.exe'

# The app cannot overwrite itself while it is running.
Get-Process -Name 'UtopiaAgent','utopia-agent' -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

Copy-Item -Path $exe.FullName -Destination $target -Force
$ico = Join-Path $InstallDir 'UtopiaAgent.ico'
Copy-Item -Path (Join-Path $repo 'src-tauri\icons\icon.ico') -Destination $ico -Force

function New-AppShortcut([string]$Path) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = "$ico,0"
  $lnk.Description = 'Utopia Agent - multi-agent coding workspace'
  $lnk.WindowStyle = 1
  $lnk.Save()
}

$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Utopia Agent.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Utopia Agent.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Utopia Agent.lnk')
)
foreach ($s in $shortcuts) { New-AppShortcut $s }

# CLI shim: `utopia-agent [path]` opens a folder as a project.
# Same location the app's own "Install terminal command" uses (see
# src-tauri/src/cli_shim.rs), so there is only ever one shim on PATH.
$binDir = Join-Path (Join-Path $env:LOCALAPPDATA 'utopia-agent') 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
@"
@echo off
start "" "$target" %*
"@ | Set-Content -Path (Join-Path $binDir 'utopia-agent.cmd') -Encoding ascii

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Write-Host "Added $binDir to the user PATH (new terminals only)."
}

Write-Host ''
Write-Host "Installed: $target"
Write-Host "Shortcuts: Desktop, Start Menu, taskbar folder"
Write-Host "CLI:       utopia-agent"
Write-Host ''
Write-Host 'To pin: launch Utopia Agent, right click its taskbar button, "Pin to taskbar".'
