# Triboon server tray helper — a small system-tray icon so you can see the Triboon Windows service is
# running and reach it in one click. It does NOT run the server (the "Triboon" Windows service does);
# it just watches that service and gives quick actions. Launched hidden at login by triboon-tray.vbs.
#
# Menu: Open dashboard (browser) · Start / Restart / Stop service (elevates via UAC) · Open logs · Exit.
# "Exit" only closes the tray icon — the server service keeps running.

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$SERVICE = 'Triboon'
$AppDir  = $PSScriptRoot

# Port: read it from the service definition so the tray follows a customized PORT; default 7777.
$Port = 7777
try {
  $svcXml = [xml](Get-Content (Join-Path $AppDir 'triboon-service.xml') -Raw)
  $envPort = ($svcXml.service.env | Where-Object { $_.name -eq 'PORT' } | Select-Object -First 1).value
  if ($envPort -match '^\d+$') { $Port = [int]$envPort }
} catch {}
$Url = "http://localhost:$Port"

# Icon: the installed Triboon logo; fall back to the app's own icon if missing.
$icoPath = Join-Path $AppDir 'triboon.ico'
$icon = if (Test-Path $icoPath) { New-Object System.Drawing.Icon $icoPath } else { [System.Drawing.SystemIcons]::Application }

function Get-SvcState {
  $s = Get-Service -Name $SERVICE -ErrorAction SilentlyContinue
  if (-not $s) { return 'not-installed' }
  return $s.Status.ToString()   # Running | Stopped | StartPending | ...
}

# Service control needs admin (LocalSystem service) — relaunch the sc action elevated (one UAC prompt).
function Invoke-SvcAdmin([string]$scArgs) {
  try { Start-Process -FilePath 'sc.exe' -ArgumentList $scArgs -Verb RunAs -WindowStyle Hidden } catch {}
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = 'Triboon'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item([string]$text, [scriptblock]$onClick) {
  $mi = New-Object System.Windows.Forms.ToolStripMenuItem
  $mi.Text = $text
  $mi.Add_Click($onClick)
  [void]$menu.Items.Add($mi)
  return $mi
}

$openItem = Add-Item 'Open Triboon dashboard' { Start-Process $Url }
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
Add-Item 'Start server'   { Invoke-SvcAdmin "start $SERVICE" }   | Out-Null
Add-Item 'Restart server' { Invoke-SvcAdmin "stop $SERVICE"; Start-Sleep -Milliseconds 800; Invoke-SvcAdmin "start $SERVICE" } | Out-Null
Add-Item 'Stop server'    { Invoke-SvcAdmin "stop $SERVICE" }    | Out-Null
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
Add-Item 'Open logs folder' { Start-Process 'explorer.exe' (Join-Path $AppDir 'logs') } | Out-Null
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
Add-Item 'Exit tray (server keeps running)' {
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
} | Out-Null

$notify.ContextMenuStrip = $menu
# Left double-click = open the dashboard (the common expectation).
$notify.Add_MouseDoubleClick({ Start-Process $Url })

# Reflect the live service state in the tooltip + gray the state-dependent items.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
  $state = Get-SvcState
  $notify.Text = "Triboon - $state ($Url)".Substring(0, [Math]::Min(63, "Triboon - $state ($Url)".Length))
})
$timer.Start()
# Prime the tooltip immediately.
$notify.Text = "Triboon - $(Get-SvcState) ($Url)".Substring(0, [Math]::Min(63, "Triboon - $(Get-SvcState) ($Url)".Length))

[System.Windows.Forms.Application]::Run()
$notify.Dispose()
