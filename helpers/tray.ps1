# Tray helper for auto-push-git-app (Windows). ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
#
# Protocol (one JSON object per line):
#   stdin  <- {"type":"init","pause":[{"minutes":60,"label":"..."}]}
#             {"type":"state","icon":"ok|pending|paused","tooltip":"...","paused":false}
#   stdout -> {"type":"ready"} | {"type":"action","name":"open|check|pause|resume|open-log|quit","minutes":60}
#             {"type":"unavailable","reason":"..."}
# Exits when stdin closes, so it can never outlive the engine.
# When AUTOPUSH_TRAY_TEST=1 it also accepts {"type":"test-click","name":..,"minutes":..} to press a menu item.

$ErrorActionPreference = 'Stop'

function Send-Msg([hashtable]$o) {
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Send-Msg @{ type = 'unavailable'; reason = 'Windows Forms is not available' }
  exit 0
}

[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:testMode = ($env:AUTOPUSH_TRAY_TEST -eq '1')

function New-TrayIcon([string]$kind) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  switch ($kind) {
    'pending' { $color = [System.Drawing.Color]::FromArgb(219, 120, 0) }
    'paused'  { $color = [System.Drawing.Color]::FromArgb(110, 118, 129) }
    default   { $color = [System.Drawing.Color]::FromArgb(46, 160, 67) }
  }
  $fill = New-Object System.Drawing.SolidBrush $color
  $white = [System.Drawing.Brushes]::White
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 4
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.FillEllipse($fill, 1, 1, 30, 30)
  switch ($kind) {
    'pending' {
      $g.DrawLine($pen, 16, 8, 16, 18)
      $g.FillEllipse($white, 13.5, 21, 5, 5)
    }
    'paused' {
      $g.FillRectangle($white, 9, 9, 5, 14)
      $g.FillRectangle($white, 18, 9, 5, 14)
    }
    default {
      $pts = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point 8, 17),
        (New-Object System.Drawing.Point 14, 23),
        (New-Object System.Drawing.Point 24, 10))
      $g.DrawLines($pen, $pts)
    }
  }
  $g.Dispose()
  # Created once at startup, so the single HICON per state is not worth a DestroyIcon P/Invoke.
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$script:icons = @{
  ok      = New-TrayIcon 'ok'
  pending = New-TrayIcon 'pending'
  paused  = New-TrayIcon 'paused'
}

$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:statusItem = $null
$script:pauseItems = @()
$script:resumeItem = $null
$script:isPaused = $false

function New-MenuEntry([string]$text, [string]$name, [int]$minutes = 0) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem $text
  $item.Tag = @{ name = $name; minutes = $minutes }
  $item.Add_Click({
    param($sender, $e)
    $tag = $sender.Tag
    $msg = @{ type = 'action'; name = $tag.name }
    if ($tag.name -eq 'pause') { $msg.minutes = $tag.minutes }
    Send-Msg $msg
  })
  return $item
}

function Build-Menu($pauseOptions) {
  $script:menu.Items.Clear()
  $script:pauseItems = @()
  $script:statusItem = New-Object System.Windows.Forms.ToolStripMenuItem 'auto-push-git-app'
  $script:statusItem.Enabled = $false
  [void]$script:menu.Items.Add($script:statusItem)
  [void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$script:menu.Items.Add((New-MenuEntry 'Open window' 'open'))
  [void]$script:menu.Items.Add((New-MenuEntry 'Check for changes now' 'check'))
  if (@($pauseOptions).Count -gt 0) {
    [void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    foreach ($p in @($pauseOptions)) {
      $it = New-MenuEntry ([string]$p.label) 'pause' ([int]$p.minutes)
      $script:pauseItems += $it
      [void]$script:menu.Items.Add($it)
    }
  }
  $script:resumeItem = New-MenuEntry 'Resume reminders' 'resume'
  $script:resumeItem.Enabled = $script:isPaused
  [void]$script:menu.Items.Add($script:resumeItem)
  [void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$script:menu.Items.Add((New-MenuEntry 'Open audit log folder' 'open-log'))
  [void]$script:menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$script:menu.Items.Add((New-MenuEntry 'Quit' 'quit'))
}

function Apply-State($msg) {
  $kind = [string]$msg.icon
  if (-not $script:icons.ContainsKey($kind)) { $kind = 'ok' }
  $script:notify.Icon = $script:icons[$kind]
  $tip = [string]$msg.tooltip
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 60) + '...' }   # NotifyIcon.Text limit
  $script:notify.Text = $tip
  $script:isPaused = [bool]$msg.paused
  foreach ($it in $script:pauseItems) { $it.Enabled = -not $script:isPaused }
  if ($script:resumeItem) { $script:resumeItem.Enabled = $script:isPaused }
  if ($script:statusItem) { $script:statusItem.Text = $tip }
}

function Invoke-TestClick($msg) {
  foreach ($it in $script:menu.Items) {
    if ($it -is [System.Windows.Forms.ToolStripMenuItem] -and $it.Tag -and $it.Tag.name -eq $msg.name) {
      if ($msg.name -ne 'pause' -or $it.Tag.minutes -eq [int]$msg.minutes) { $it.PerformClick(); return }
    }
  }
}

function Handle-Line([string]$line) {
  try { $msg = $line | ConvertFrom-Json } catch { return }
  switch ($msg.type) {
    'init'       { Build-Menu $msg.pause }
    'state'      { Apply-State $msg }
    'test-click' { if ($script:testMode) { Invoke-TestClick $msg } }
  }
}

function Stop-Tray {
  $script:timer.Stop()
  $script:notify.Visible = $false
  $script:notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

Build-Menu @()

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Icon = $script:icons['ok']
$script:notify.Text = 'auto-push-git-app'
$script:notify.ContextMenuStrip = $script:menu
$script:notify.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send-Msg @{ type = 'action'; name = 'open' } }
})
$script:notify.Visible = $true

$script:readTask = [Console]::In.ReadLineAsync()
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 150
$script:timer.Add_Tick({
  try {
    while ($script:readTask.IsCompleted) {
      $line = $script:readTask.Result
      if ($null -eq $line) { Stop-Tray; return }   # stdin closed: engine is gone
      if ($line.Trim().Length -gt 0) { Handle-Line $line }
      $script:readTask = [Console]::In.ReadLineAsync()
    }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
})
$script:timer.Start()

Send-Msg @{ type = 'ready' }
[System.Windows.Forms.Application]::Run()
