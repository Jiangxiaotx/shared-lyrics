# bridge.ps1 - 读取并控制 Windows 媒体会话（QQ 音乐支持系统媒体控制 SMTC）
# 上行：每 350ms 向标准输出写一行 JSON，前缀 ST
# 下行：从标准输入读取指令：play / pause / toggle / next / prev / seek 123.4

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# 找到 AsTask<T> 泛型方法，用来把 WinRT 异步操作同步等待
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*1'
})[0]

function Await($op, $type) {
  if ($null -eq $op) { return $null }
  try {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $nt = $m.Invoke($null, @($op))
    if (-not $nt.Wait(4000)) { return $null }
    return $nt.Result
  } catch { return $null }
}

function JStr($s) {
  if ($null -eq $s) { return '""' }
  $t = [string]$s
  $t = $t.Replace('\','\\').Replace('"','\"')
  $t = $t.Replace([string][char]13,' ').Replace([string][char]10,' ')
  return '"' + $t + '"'
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$propsCache = @{}
$loop = 0
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$out.AutoFlush = $true

function Get-Session {
  if ($null -eq $mgr) { return $null }
  $list = @()
  try { $list = @($mgr.GetSessions()) } catch { $script:gsErr = $_.Exception.Message; return $null }
  if ($list.Count -eq 0) { return $null }
  # 优先 QQ 音乐，其它播放器兜底
  $qm = $list | Where-Object { $_.SourceAppUserModelId -match 'QQ|Music' } | Select-Object -First 1
  if ($qm) { return $qm }
  return ($list | Select-Object -First 1)
}

function Emit-State {
  $s = Get-Session
  if ($null -eq $s) {
    $dbg = 'mgr=' + ([bool]($null -ne $mgr)) + ' err=' + [string]$script:gsErr
    $out.WriteLine('ST {"ok":true,"found":false,"dbg":' + (JStr $dbg) + '}')
    $out.Flush()
    return
  }
  $key = [string]$s.SourceAppUserModelId
  $info = $null
  try { $info = $s.GetPlaybackInfo() } catch {}
  $status = 'Unknown'
  if ($info) { $status = [string]$info.PlaybackStatus }

  $props = $null
  if ($loop % 3 -eq 0 -or -not $propsCache.ContainsKey($key)) {
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if ($props) { $propsCache[$key] = $props }
  } else {
    $props = $propsCache[$key]
  }

  $title = ''
  $artist = ''
  $album = ''
  if ($props) {
    $title = [string]$props.Title
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
  }

  $pos = 0.0
  $dur = 0.0
  $rate = 1.0
  try {
    $tl = $s.GetTimelineProperties()
    if ($tl) {
      $pos = $tl.Position.TotalSeconds
      $dur = $tl.EndTime.TotalSeconds - $tl.StartTime.TotalSeconds
      if ($dur -lt 0) { $dur = 0 }
      if ($status -eq 'Playing') {
        $lag = ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
        if ($lag -gt 0 -and $lag -lt 15) { $pos = $pos + $lag * $rate }
      }
      if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
    }
  } catch {}
  if ($null -ne $info) { try { $rate = [double]$info.PlaybackRate } catch {} }

  $json = 'ST {"ok":true,"found":true,"app":' + (JStr $key) + ',"status":' + (JStr $status) +
          ',"title":' + (JStr $title) + ',"artist":' + (JStr $artist) + ',"album":' + (JStr $album) +
          ',"pos":' + ([math]::Round($pos,2)) + ',"dur":' + ([math]::Round($dur,2)) +
          ',"rate":' + $rate + ',"ts":' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + '}'
  $out.WriteLine($json)
  $out.Flush()
}

function Handle-Cmd($line) {
  $parts = $line -split '\s+', 2
  $cmd = $parts[0].ToLower()
  $val = 0.0
  if ($parts.Count -gt 1) { [void][double]::TryParse($parts[1], [ref]$val) }
  $s = Get-Session
  if ($null -eq $s) { $out.WriteLine('ERR no-session'); $out.Flush(); return }
  switch ($cmd) {
    'play'   { [void](Await ($s.TryPlayAsync()) ([bool])) }
    'pause'  { [void](Await ($s.TryPauseAsync()) ([bool])) }
    'toggle' { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
    'next'   { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
    'prev'   { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
    'seek'   { $ticks = [long]($val * 10000000); [void](Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])) }
  }
  Emit-State
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$pending = $null

while ($true) {
  Emit-State
  if ($null -eq $mgr -and ($loop % 15 -eq 0)) {
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  if ($null -eq $pending) { $pending = $stdin.ReadLineAsync() }
  while ($null -ne $pending -and $pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { $pending = $null; break }
    $line = $line.Trim()
    if ($line.Length -gt 0) { Handle-Cmd $line }
    $pending = $stdin.ReadLineAsync()
  }
  $loop++
  Start-Sleep -Milliseconds 350
}
