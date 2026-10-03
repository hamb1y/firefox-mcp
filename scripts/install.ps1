# WebMCP Controller — helper installer for Windows.
#   irm https://github.com/hamb1y/webmcp-controller/releases/latest/download/install.ps1 | iex
# Downloads the right webmcp-host .exe and registers it with Firefox (per user, no admin).
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest very slow on PowerShell 5.1
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $base = if ($env:WEBMCP_BASE) { $env:WEBMCP_BASE } else { 'https://github.com/hamb1y/webmcp-controller/releases/latest/download' }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $name = "webmcp-host-windows-$arch.exe"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("fxmcp-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $exe = Join-Path $tmp $name

  try {
    Write-Host "Downloading $name ..."
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $exe

    try {
      $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
      $line = ($sums -split "`n") | Where-Object { $_ -match " $([regex]::Escape($name))\s*$" } | Select-Object -First 1
      if ($line) {
        $want = ($line -split '\s+')[0].ToLower()
        $got = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
        if ($want -ne $got) { throw "Checksum mismatch for $name - download corrupted, try again." }
      }
    } catch [System.Net.WebException] { }

    & $exe install
    if ($LASTEXITCODE) { throw "Install failed (exit $LASTEXITCODE)." }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
