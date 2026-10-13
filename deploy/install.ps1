<#
.SYNOPSIS
Keel installer for Windows: sets up Keel with the published images on Docker
Desktop (WSL 2 backend), in Windows PowerShell 5.1 or PowerShell 7.

.DESCRIPTION
  irm @@SITE@@/install.ps1 | iex

Or download it, check it and then run it (see the install guide):

  Invoke-WebRequest @@SITE@@/install.ps1 -OutFile install.ps1 -UseBasicParsing
  Invoke-WebRequest @@SITE@@/install.ps1.sha256 -OutFile install.ps1.sha256 -UseBasicParsing
  (Get-FileHash install.ps1).Hash -eq (Get-Content install.ps1.sha256).Split(' ')[0]   # run it only if True
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Lan

Run it again to update an existing install: it backs up every database first,
and -Rollback goes back to the version before. With `irm | iex`, give options
as environment variables (in brackets below), e.g. $env:KEEL_LAN = 'yes'.

Studio and Postgres listen on this PC only unless you choose otherwise. The
API (port 8000) is open to your network, so phones and other computers can
use your apps.

.PARAMETER Dir
Where to install [KEEL_DIR]. Default: the keel folder in your user folder.
.PARAMETER Version
Version to install or update to, e.g. 0.2.0 [KEEL_VERSION]. Default: the newest release.
.PARAMETER Url
How apps reach the API [KEEL_PUBLIC_URL]. Default: http://<this PC's IP>:8000
.PARAMETER HostName
Just the address part of that, e.g. mypc.local [KEEL_HOST].
.PARAMETER Lan
Open Studio to your network [KEEL_LAN=yes].
.PARAMETER NoLan
Keep Studio on this PC only [KEEL_LAN=no].
.PARAMETER LanDb
Open Postgres to your network too [KEEL_DB_LAN=yes].
.PARAMETER Yes
Don't ask questions; use the defaults [KEEL_YES=1].
.PARAMETER Rollback
Go back to the version before the last update.
.PARAMETER Restore
With -Rollback: also restore the databases backed up before that update.
.PARAMETER ProjectName
Docker Compose project name [KEEL_PROJECT_NAME]. Default: keel. Needed for a second Keel on one PC.
.PARAMETER GatewayPort
API port [KEEL_GATEWAY_PORT]. Default: 8000.
.PARAMETER StudioPort
Studio port [KEEL_STUDIO_PORT]. Default: 3000.
.PARAMETER DbPort
Postgres port [KEEL_DB_PORT]. Default: 5432.
.PARAMETER DryRun
Check everything, download and verify the files, and show what would be done,
without changing anything.
#>
[CmdletBinding()]
param(
  [string]$Dir = $env:KEEL_DIR,
  [string]$Version = $env:KEEL_VERSION,
  [string]$Url = $env:KEEL_PUBLIC_URL,
  [string]$HostName = $env:KEEL_HOST,
  [switch]$Lan,
  [switch]$NoLan,
  [switch]$LanDb,
  [switch]$Yes,
  [switch]$Rollback,
  [switch]$Restore,
  [string]$ProjectName = $env:KEEL_PROJECT_NAME,
  [string]$GatewayPort = $env:KEEL_GATEWAY_PORT,
  [string]$StudioPort = $env:KEEL_STUDIO_PORT,
  [string]$DbPort = $env:KEEL_DB_PORT,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SITE = '@@SITE@@'
$IMAGES = '@@IMAGES@@'
# Where the compose files and the keel command come from: the website, or for
# the installer attached to a GitHub release, that release (whose version is
# then the default).
$FILES = '@@FILES@@'
$RELEASE = '@@RELEASE@@'

class KeelError : System.Exception { KeelError([string]$m) : base($m) {} }
function Exit-Install([string]$Message) { throw [KeelError]::new($Message) }
function Write-Say([string]$Message) { Write-Host $Message }

function Write-Utf8File([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

# Only the current user (and SYSTEM and Administrators) can read the file, like chmod 600.
function Protect-KeelFile([string]$Path) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r "*${sid}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "couldn't restrict access to $Path" }
}

# The install folder too, and everything in it, like the user folder itself:
# a folder made elsewhere (C:\keel, D:\keel) lets every user of the PC read the
# backups and change the keel command. Only a folder that is empty or already
# holds Keel; never a drive's root.
function Protect-KeelFolder([string]$Path) {
  if ($Path.TrimEnd('\') -eq ([IO.Path]::GetPathRoot($Path)).TrimEnd('\')) { Write-Warning "$Path is a drive's root; its permissions are left alone"; return }
  $keel = (Test-Path -LiteralPath (Join-Path $Path '.env')) -and (Test-Path -LiteralPath (Join-Path $Path 'docker-compose.yml'))
  if (-not $keel -and @(Get-ChildItem -LiteralPath $Path -Force).Count) { Write-Warning "$Path already holds other files; its permissions are left alone"; return }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "couldn't restrict access to $Path" }
}

# Runs docker and returns its output (trimmed), or $null when it fails. Errors stay quiet.
function Get-DockerOutput {
  $ErrorActionPreference = 'Continue'
  $out = & docker @args 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ((@($out) | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Read-YesNo([string]$Question, [bool]$Default) {
  if ($script:AssumeYes -or -not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return $Default }
  $hint = if ($Default) { 'Y/n' } else { 'y/N' }
  $answer = Read-Host "$Question [$hint]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer -match '^[Yy]'
}

function Test-Truthy([string]$Value) { return $Value -match '^(yes|1|true|on)$' }

# --- Downloads, checked against the published SHA-256 checksums --------------------

$script:Sums = $null
function Get-Checksum([string]$Name) {
  if ($null -eq $script:Sums) {
    $script:Sums = @{}
    try {
      $text = (Invoke-WebRequest -UseBasicParsing -Uri "$FILES/SHA256SUMS").Content
      if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
    } catch { Exit-Install "could not download $FILES/SHA256SUMS: $($_.Exception.Message)" }
    foreach ($line in ($text -split "`n")) {
      if ($line -match '^([0-9a-fA-F]{64}) [ *]?(\S+)\s*$') { $script:Sums[$Matches[2]] = $Matches[1].ToLowerInvariant() }
    }
  }
  if (-not $script:Sums.ContainsKey($Name)) { Exit-Install "$Name is not listed in $FILES/SHA256SUMS" }
  return $script:Sums[$Name]
}

# Downloads a published file to $Dest, but only if its checksum matches.
function Save-KeelFile([string]$Name, [string]$Dest) {
  $expected = Get-Checksum $Name
  $tmp = "$Dest.download"
  try { Invoke-WebRequest -UseBasicParsing -Uri "$FILES/$Name" -OutFile $tmp }
  catch { Exit-Install "could not download $FILES/${Name}: $($_.Exception.Message)" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item -Force -LiteralPath $tmp
    Exit-Install "$Name doesn't match its published checksum (expected $expected, got $actual); nothing was changed"
  }
  Move-Item -Force -LiteralPath $tmp -Destination $Dest
}

# Keeps the last five copies of a file as NAME.bak.<time>, newest first.
function Backup-KeelFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $base = "$Path.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  $name = $base; $n = 1
  while (Test-Path -LiteralPath $name) { $name = '{0}-{1:00}' -f $base, $n; $n++ }
  Copy-Item -LiteralPath $Path -Destination $name
  # A copy takes the folder's permissions, not the file's: .env's copies hold its passwords.
  Protect-KeelFile $name
  $leaf = Split-Path -Leaf $Path
  Get-ChildItem -LiteralPath (Split-Path -Parent $Path) -Filter "$leaf.bak.*" -File | Sort-Object Name -Descending |
    Select-Object -Skip 5 | ForEach-Object { Remove-Item -Force -LiteralPath $_.FullName }
}

# --- Network ---------------------------------------------------------------------------

function Test-HostLike([string]$Value) {
  if ($Value -match '^([0-9]{1,3}\.){3}[0-9]{1,3}$') { return $true }
  return $Value.Length -le 253 -and $Value -match '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
}

# This PC's address on your network: the adapter with a default gateway.
function Get-LanAddress {
  $ip = ''
  try {
    $cfg = Get-NetIPConfiguration | Where-Object { $null -ne $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    if ($cfg) { $ip = @($cfg.IPv4Address)[0].IPAddress }
  } catch { Write-Verbose "no network configuration: $($_.Exception.Message)" }
  if ($ip -and (Test-HostLike $ip)) { return $ip }
  return 'localhost'
}

# Every IPv4 address of this PC (comma separated), so function code can't
# reach it even inside an allowed LAN range.
function Get-HostAddressList {
  $list = @()
  try {
    $list = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | ForEach-Object { $_.IPAddress })
  } catch { Write-Verbose "no addresses: $($_.Exception.Message)" }
  $lan = Get-LanAddress
  if ($lan -ne 'localhost') { $list += $lan }
  return (($list | Sort-Object -Unique) -join ',')
}

function Test-PrivateAddress([string]$Value) {
  return $Value -match '^(10\.|192\.168\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' -or
    $Value -match '(^localhost$|\.local$|\.lan$|\.home$|\.home\.arpa$|\.internal$)'
}

function Test-PortInUse([int]$Port) {
  try { return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) }
  catch { return $false }
}

# --- Waiting for Keel ---------------------------------------------------------------------

function Get-ContainerHealth([string]$Service) {
  $id = Get-DockerOutput compose ps -q $Service
  if (-not $id) { return 'missing' }
  return Get-DockerOutput inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ($id -split "`n")[0]
}

function Wait-Keel([string]$Port) {
  Write-Say 'Waiting for Keel to start (up to 5 minutes)...'
  for ($i = 0; $i -lt 100; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/health"
      if ($r.StatusCode -eq 200) { return $true }
    } catch { Write-Verbose 'not answering yet' }
    if ((Get-ContainerHealth keel-studio) -eq 'healthy' -and (Get-ContainerHealth keel-gateway) -eq 'healthy') { return $true }
    Start-Sleep -Seconds 3
  }
  Write-Warning "Keel didn't start: Studio never answered on port $Port."
  & docker compose ps -a
  Write-Warning 'Last log lines of the database, migrations and Studio:'
  & docker compose logs --tail 20 keel-db keel-migrate keel-studio
  return $false
}

# Runs the keel command in the install folder in a PowerShell of its own.
function Invoke-KeelCli([string]$Folder, [string[]]$Arguments) {
  $shell = (Get-Process -Id $PID).Path
  # Its output goes to the screen, not into this function's return value.
  & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Folder 'keel-cli.ps1') @Arguments | Out-Host
  return $LASTEXITCODE
}

# --- The installer -----------------------------------------------------------------------

function Install-Keel {
  # Options also come from the environment, for `irm | iex`.
  $lanChoice = ''
  if ($Lan) { $lanChoice = 'yes' } elseif ($NoLan) { $lanChoice = 'no' }
  elseif ($env:KEEL_LAN) {
    if (Test-Truthy $env:KEEL_LAN) { $lanChoice = 'yes' }
    elseif ($env:KEEL_LAN -match '^(no|0|false|off)$') { $lanChoice = 'no' }
    else { Exit-Install 'KEEL_LAN must be yes or no' }
  }
  $dbLan = $LanDb -or (Test-Truthy $env:KEEL_DB_LAN)
  $script:AssumeYes = $Yes -or [bool]$env:KEEL_YES
  $doRestore = $Restore

  if ($env:OS -ne 'Windows_NT') { Exit-Install 'this installer is for Windows; on Linux and macOS use install.sh' }
  if ($FILES.StartsWith('@@')) { Exit-Install 'this copy of install.ps1 comes from the source code; download it from the Keel website or a release instead' }
  if ($Version) {
    $Version = $Version -replace '^v', ''
    if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { Exit-Install '-Version: use a tag such as 0.2.0 or latest' }
  }
  if ($Url -and $Url -notmatch '^https?://\S+$') { Exit-Install '-Url must look like http://192.168.1.20:8000 or https://api.example.com' }
  if ($ProjectName -and $ProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') { Exit-Install '-ProjectName: lowercase letters, digits, dashes and underscores' }
  foreach ($p in @($GatewayPort, $StudioPort, $DbPort)) {
    if ($p -and ($p -notmatch '^[0-9]{1,5}$' -or [int]$p -lt 1 -or [int]$p -gt 65535)) { Exit-Install "not a port number: $p" }
  }
  # Windows PowerShell 5.1 may not offer TLS 1.2 by itself.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { Write-Verbose 'TLS settings unchanged' }

  # --- Docker Desktop ---
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Exit-Install 'Docker is required: install Docker Desktop (https://www.docker.com/products/docker-desktop/) with the WSL 2 backend, start it, then run this again.'
  }
  if ($null -eq (Get-DockerOutput compose version)) { Exit-Install 'the Docker Compose plugin is required (docker compose version); update Docker Desktop' }
  $osType = Get-DockerOutput info --format '{{.OSType}}'
  if ($null -eq $osType) { Exit-Install "can't talk to Docker. Start Docker Desktop, wait until it says it's running, then run this again." }
  if ($osType -ne 'linux') { Exit-Install 'Docker Desktop runs Windows containers: right-click its icon and choose "Switch to Linux containers", then run this again.' }

  # --- Where ---
  if (-not $Dir) { $Dir = Join-Path $env:USERPROFILE 'keel' }
  $Dir = [IO.Path]::GetFullPath($Dir)
  if ($Dir -match '\\OneDrive') { Write-Warning "$Dir is in OneDrive, which locks and syncs files Keel is writing. A folder outside OneDrive is better." }
  if ($Dir.StartsWith('\\')) { Exit-Install 'install on a local drive: Docker Desktop and Postgres need one (not a network share)' }

  if ($Rollback) {
    if (-not (Test-Path -LiteralPath (Join-Path $Dir '.env')) -or -not (Test-Path -LiteralPath (Join-Path $Dir 'keel-cli.ps1'))) { Exit-Install "no Keel install in $Dir to roll back" }
    $a = @('rollback'); if ($doRestore) { $a += '--restore' }; if ($script:AssumeYes) { $a += '--yes' }
    if ($DryRun) { Write-Say "Would run: $Dir\keel $($a -join ' ')"; return }
    if ((Invoke-KeelCli $Dir $a) -ne 0) { Exit-Install 'rollback failed; see the messages above' }
    return
  }
  if ($doRestore) { Exit-Install '-Restore goes with -Rollback' }

  $work = $Dir
  if ($DryRun) {
    $work = Join-Path ([IO.Path]::GetTempPath()) ('keel-dry-run-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $script:DryRunDir = $work
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Write-Say "Dry run: nothing in $Dir changes and no containers start. Files are checked in $work."
  } else {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Protect-KeelFolder $Dir
  }
  Set-Location -LiteralPath $work
  [Environment]::CurrentDirectory = $work

  $envFile = Join-Path $Dir '.env'
  if (Test-Path -LiteralPath (Join-Path $Dir 'docker-compose.yml')) {
    # --- Update ---
    if (-not (Test-Path -LiteralPath $envFile)) { Exit-Install "$Dir has a docker-compose.yml but no .env; not touching it" }
    Write-Say "Keel is already installed in ${Dir}: updating it."
    Save-KeelFile keel-cli.ps1 (Join-Path $work 'keel-cli.ps1.new')
    Save-KeelFile keel.cmd (Join-Path $work 'keel.cmd.new')
    Save-KeelFile docker-compose.yml (Join-Path $work 'docker-compose.yml.new')
    Save-KeelFile docker-compose.windows.yml (Join-Path $work 'docker-compose.windows.yml.new')
    $a = @('update', '--compose', 'docker-compose.yml.new')
    $target = $Version; if ($target -eq 'latest') { $target = '' }; if (-not $target) { $target = $RELEASE }
    if ($target) { $a += @('--version', $target) }
    if ($script:AssumeYes) { $a += '--yes' }
    if ($DryRun) {
      Write-Say "The files check out. Would back up .env and the compose files, then run: $Dir\keel $($a -join ' ')"
      return
    }
    Backup-KeelFile $envFile
    Backup-KeelFile (Join-Path $Dir 'docker-compose.yml')
    Backup-KeelFile (Join-Path $Dir 'docker-compose.windows.yml')
    Move-Item -Force 'keel-cli.ps1.new' 'keel-cli.ps1'
    Move-Item -Force 'keel.cmd.new' 'keel.cmd'
    # Settings chosen on the command line apply to the update too.
    $set = @{}
    if ($lanChoice) { $set['KEEL_STUDIO_BIND'] = $(if ($lanChoice -eq 'yes') { '0.0.0.0' } else { '127.0.0.1' }) }
    if ($dbLan) { $set['KEEL_DB_BIND'] = '0.0.0.0'; $set['KEEL_DB_GATEWAY'] = 'remote' }
    if ($Url) { $set['KEEL_PUBLIC_URL'] = $Url }
    $lines = @([IO.File]::ReadAllLines($envFile) | Where-Object { $line = $_; -not ($set.Keys | Where-Object { $line.StartsWith("$_=") }) })
    foreach ($k in $set.Keys) { $lines += "$k=$($set[$k])" }
    Write-Utf8File "$envFile.new" (($lines -join "`n") + "`n")
    Protect-KeelFile "$envFile.new"
    Move-Item -Force -LiteralPath "$envFile.new" -Destination $envFile
    if ((Invoke-KeelCli $Dir $a) -ne 0) {
      Exit-Install "update failed. To go back to the previous version: cd $Dir; .\keel rollback`n(earlier settings are in $Dir\.env.bak.*, earlier compose files in $Dir\docker-compose.yml.bak.*)"
    }
    Write-Say "Done. Your settings and data were kept; the databases were backed up to $Dir\backups\pre-update first."
    return
  }

  # --- New install ---
  $project = if ($ProjectName) { $ProjectName } else { 'keel' }
  # Another Keel (or anything else) under the same Compose project name would be taken over.
  foreach ($labels in @((Get-DockerOutput ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Labels}}') -split "`n" | Where-Object { $_ })) {
    if ($labels -match 'com\.docker\.compose\.project\.working_dir=([^,]*)' -and $Matches[1] -ne $Dir) {
      Exit-Install "Docker already runs a Compose project called '$project' from $($Matches[1]). Pick another name with -ProjectName (and other ports with -GatewayPort, -StudioPort and -DbPort)."
    }
  }
  if ($null -ne (Get-DockerOutput volume inspect "${project}_db")) {
    Exit-Install "a Keel database (the Docker volume ${project}_db) already exists but there are no Keel settings in $Dir. Install into the folder that has its .env, or remove the volume first (docker volume rm ${project}_db deletes those databases)."
  }
  $ports = [ordered]@{ API = $(if ($GatewayPort) { $GatewayPort } else { '8000' }); Studio = $(if ($StudioPort) { $StudioPort } else { '3000' }); Postgres = $(if ($DbPort) { $DbPort } else { '5432' }) }
  foreach ($k in $ports.Keys) {
    if (Test-PortInUse ([int]$ports[$k])) {
      Exit-Install "port $($ports[$k]) ($k) is already in use on this PC. Choose another with -GatewayPort, -StudioPort or -DbPort (or stop the program using it)."
    }
  }

  # Install a version, never a moving tag: the newest release unless chosen.
  $tag = if ($Version) { $Version } else { $RELEASE }
  if ($tag -eq 'latest') { $tag = '' }
  if (-not $HostName) { $HostName = Get-LanAddress }
  if (-not (Test-HostLike $HostName)) { Exit-Install '-HostName must be an IP address or a host name' }
  if (-not $Url) { $Url = "http://${HostName}:$($ports.API)" }

  # Studio: this PC only unless you say otherwise.
  $studioBind = '127.0.0.1'
  if ($lanChoice -eq 'yes') { $studioBind = '0.0.0.0' }
  elseif ($lanChoice -ne 'no' -and (Test-PrivateAddress $HostName) -and -not $DryRun) {
    if (Read-YesNo 'Open Studio (the dashboard) to your local network? (No: only this PC can open it)' $false) { $studioBind = '0.0.0.0' }
  }
  # Docker Desktop hides where connections come from, so Postgres can't tell
  # this PC from the rest of the network once it listens there.
  $dbBind = '127.0.0.1'; $dbGateway = 'local'
  if ($dbLan) {
    $dbBind = '0.0.0.0'; $dbGateway = 'remote'
    Write-Say 'Docker Desktop hides where connections come from, so Postgres treats every connection to its port'
    Write-Say "as coming from your network, this PC's too: TLS is required and postgres can't sign in."
  }

  Save-KeelFile docker-compose.yml (Join-Path $work 'docker-compose.yml')
  Save-KeelFile docker-compose.windows.yml (Join-Path $work 'docker-compose.windows.yml')
  Save-KeelFile keel-cli.ps1 (Join-Path $work 'keel-cli.ps1')
  Save-KeelFile keel.cmd (Join-Path $work 'keel.cmd')

  if ($DryRun) {
    $shown = if ($tag) { $tag } else { 'the newest release' }
    Write-Say ''
    Write-Say 'The files check out against SHA256SUMS. A real run would:'
    Write-Say "  install Keel $shown into $Dir (Compose project $project)"
    Write-Say "  API for your apps:   $Url/my-app   (port $($ports.API), open to your network)"
    Write-Say "  Studio:              port $($ports.Studio) on $studioBind   Postgres: port $($ports.Postgres) on $dbBind"
    Write-Say "  images:              $IMAGES/keel and $IMAGES/keel-functions"
    return
  }

  if (-not $tag) {
    & docker pull -q "${IMAGES}/keel:latest" | Out-Null
    if ($LASTEXITCODE -ne 0) { Exit-Install "could not download ${IMAGES}/keel:latest" }
    $json = Get-DockerOutput image inspect --format '{{json .Config.Labels}}' "${IMAGES}/keel:latest"
    $tag = ''
    if ($json -and $json -ne 'null') { $v = ($json | ConvertFrom-Json).PSObject.Properties['org.opencontainers.image.version']; if ($v) { $tag = [string]$v.Value } }
    if ($tag -notmatch '^[0-9]+\.[0-9]+\.[0-9]+') { $tag = 'latest' }
  }
  Write-Say "Installing Keel $tag into $Dir"
  Write-Say 'Downloading the images (the first time takes a few minutes)...'
  foreach ($name in 'keel', 'keel-functions') {
    & docker pull -q "${IMAGES}/${name}:$tag" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      if ($null -eq (Get-DockerOutput image inspect "${IMAGES}/${name}:$tag")) { Exit-Install "could not download ${IMAGES}/${name}:$tag" }
      Write-Warning "couldn't download ${IMAGES}/${name}:$tag; using the copy on this PC"
    }
  }
  $secrets = Get-DockerOutput run --rm "${IMAGES}/keel:$tag" generate-env
  if (-not $secrets -or $secrets -notmatch 'POSTGRES_PASSWORD=.') { Exit-Install 'could not generate passwords' }
  $pw = ''
  foreach ($line in ($secrets -split "`n")) { if ($line.StartsWith('KEEL_DASHBOARD_PASSWORD=')) { $pw = $line.Substring(24).Trim() } }

  $lines = @(
    "# Keel settings. Keep a copy somewhere safe: the passwords can't be recovered from the database."
    "KEEL_PUBLIC_URL=$Url"
    "KEEL_VERSION=$tag"
  )
  $lines += @($secrets -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $lines += @(
    '# 127.0.0.1: this PC only; 0.0.0.0: your network too.'
    "KEEL_STUDIO_BIND=$studioBind"
    "KEEL_DB_BIND=$dbBind"
    "KEEL_DB_GATEWAY=$dbGateway"
    "KEEL_HOST_ADDRESSES=$(Get-HostAddressList)"
    '# Docker Desktop: the database lives in a Docker volume (see docker-compose.windows.yml).'
    'COMPOSE_FILE=docker-compose.yml;docker-compose.windows.yml'
    'COMPOSE_PATH_SEPARATOR=;'
  )
  # A second Keel keeps its own network for the tunnel, apart from the first one's keel-public.
  if ($ProjectName) { $lines += @("COMPOSE_PROJECT_NAME=$ProjectName", "KEEL_PUBLIC_NETWORK=$ProjectName-public") }
  if ($GatewayPort) { $lines += "KEEL_GATEWAY_PORT=$GatewayPort" }
  if ($StudioPort) { $lines += "KEEL_STUDIO_PORT=$StudioPort" }
  if ($DbPort) { $lines += "KEEL_DB_PORT=$DbPort" }
  Write-Utf8File "$envFile.new" (($lines -join "`n") + "`n")
  Protect-KeelFile "$envFile.new"
  Move-Item -Force -LiteralPath "$envFile.new" -Destination $envFile
  foreach ($d in 'db-tls', 'storage', 'backups', 'functions', 'tunnel') { New-Item -ItemType Directory -Force -Path (Join-Path $Dir $d) | Out-Null }

  & docker compose up -d
  if ($LASTEXITCODE -ne 0 -or -not (Wait-Keel $ports.Studio)) {
    Exit-Install "Keel was installed in $Dir but didn't start. Fix the problem above, then run: cd $Dir; .\keel up"
  }

  if ($studioBind -eq '0.0.0.0') { $studio = "http://${HostName}:$($ports.Studio)" }
  else { $studio = "http://localhost:$($ports.Studio)   (this PC only; run again with -Lan to open it to your network)" }
  Write-Say @"

Keel is running.

  Studio (dashboard):  $studio
  Sign in:             admin / $pw
  API for your apps:   $Url/my-app
  Settings:            $envFile   (passwords; keep a copy somewhere safe)
  Data:                $Dir\{storage,backups,functions,tunnel} and the Docker volume ${project}_db

Next: open Studio, change your password and turn on two-factor authentication
under "Account and security". Manage Keel in that folder with .\keel (.\keel help);
update with .\keel update. If Windows Firewall asks whether Docker Desktop may
accept connections, allow private networks so other devices can reach the API.
Guides: $SITE
"@
}

$here = (Get-Location).Path
$hereProcess = [Environment]::CurrentDirectory
$script:DryRunDir = ''
$failed = $false
try {
  Install-Keel
} catch [KeelError] {
  Write-Host "keel: $($_.Exception.Message)" -ForegroundColor Red
  $failed = $true
} finally {
  Set-Location -LiteralPath $here
  [Environment]::CurrentDirectory = $hereProcess
  if ($script:DryRunDir -and (Test-Path -LiteralPath $script:DryRunDir)) { Remove-Item -Recurse -Force -LiteralPath $script:DryRunDir }
}
# Run as a file: exit with an error. Through `irm | iex`: don't close the window.
if ($failed -and $PSCommandPath) { exit 1 }
