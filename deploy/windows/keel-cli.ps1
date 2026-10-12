# Keel command for Windows (Windows PowerShell 5.1 or PowerShell 7) in a
# folder set up by the Windows installer (install.ps1). Run it through
# keel.cmd next to it, which works whatever the execution policy:
#
#   cd $HOME\keel
#   .\keel help
#
# The commands, options, .env settings and update backups are the same as the
# bash `keel` command's, so the documentation for one applies to the other.
# In a copy of the source code, use the bash `keel` (Git Bash or WSL).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { Write-Verbose 'no console' }

$script:OrigPwd = (Get-Location).Path
Set-Location -LiteralPath $PSScriptRoot
[Environment]::CurrentDirectory = $PSScriptRoot

$script:PreUpdateDir = 'backups\pre-update'
$script:KeepPreUpdate = 3
$script:AssumeYes = $false

class KeelError : System.Exception { KeelError([string]$m) : base($m) {} }
function Exit-Keel([string]$Message) { throw [KeelError]::new($Message) }

# --- Helpers --------------------------------------------------------------------

function Write-Utf8File([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), $Text, (New-Object System.Text.UTF8Encoding $false))
}

# Only the current user (and SYSTEM and Administrators) can read the file, like chmod 600.
function Protect-KeelFile([string]$Path) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r "*${sid}:F" '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "couldn't restrict access to $Path" }
}

# Runs docker; stops with an error when it fails.
function Invoke-Docker {
  & docker @args
  if ($LASTEXITCODE -ne 0) { Exit-Keel "docker $($args -join ' ') failed" }
}

# Runs docker and returns its output (trimmed), or $null when it fails. Errors stay quiet.
function Get-DockerOutput {
  $ErrorActionPreference = 'Continue'
  $out = & docker @args 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ((@($out) | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Get-EnvValue([string]$Key) {
  $value = ''
  if (Test-Path -LiteralPath .env) {
    foreach ($line in [IO.File]::ReadAllLines((Join-Path $PSScriptRoot '.env'))) {
      if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1).TrimEnd("`r") }
    }
  }
  if ($value.StartsWith('"')) { $value = $value.Substring(1) }
  if ($value.EndsWith('"')) { $value = $value.Substring(0, $value.Length - 1) }
  return $value
}

# Sets a setting in .env, replacing an existing line. Written to a new file
# (owner-only) that then replaces .env, so .env is never half-written.
function Write-EnvValue([string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath .env) {
    $lines = @([IO.File]::ReadAllLines((Join-Path $PSScriptRoot '.env')) | Where-Object { -not $_.StartsWith("$Key=") })
  }
  $lines += "$Key=$Value"
  $tmp = Join-Path $PSScriptRoot ('.env.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  Write-Utf8File $tmp (($lines -join "`n") + "`n")
  Protect-KeelFile $tmp
  Move-Item -LiteralPath $tmp -Destination (Join-Path $PSScriptRoot '.env') -Force
}

function Read-YesNo([string]$Question, [bool]$Default) {
  if ($script:AssumeYes) { return $true }
  if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return $Default }
  $hint = if ($Default) { 'Y/n' } else { 'y/N' }
  $answer = Read-Host "$Question [$hint]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer -match '^[Yy]'
}

function Test-KeelVersion([string]$Version) { return $Version -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' }

# True when version $A is lower than $B (as `sort -V` orders them).
function Test-VersionLower([string]$A, [string]$B) {
  if ($A -eq $B) { return $false }
  $pa = $A.Split('-', 2); $pb = $B.Split('-', 2)
  $va = [version]$pa[0]; $vb = [version]$pb[0]
  if ($va -ne $vb) { return $va -lt $vb }
  if ($pa.Count -eq 1) { return $true }
  if ($pb.Count -eq 1) { return $false }
  return [string]::CompareOrdinal($pa[1], $pb[1]) -lt 0
}

function Get-FullPath([string]$Path) {
  if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
  return [IO.Path]::GetFullPath((Join-Path $script:OrigPwd $Path))
}

function Assert-Installed {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Exit-Keel 'Docker is required: start Docker Desktop' }
  if (Test-Path -LiteralPath Dockerfile) { Exit-Keel 'this is a copy of the source code: use the bash keel command (Git Bash or WSL) here' }
  if (-not (Test-Path -LiteralPath .env)) { Exit-Keel 'no .env here. Install Keel with install.ps1 first.' }
}

# Studio's address: localhost when it listens on this machine only.
function Get-StudioUrl {
  $port = Get-EnvValue KEEL_STUDIO_PORT; if (-not $port) { $port = '3000' }
  $bind = Get-EnvValue KEEL_STUDIO_BIND; if (-not $bind) { $bind = '127.0.0.1' }
  $h = 'localhost'
  if ($bind -notmatch '^(127\.|localhost)') {
    $u = Get-EnvValue KEEL_PUBLIC_URL
    if ($u -match '^https?://([^/:]+)') { $h = $Matches[1] }
  }
  return "http://${h}:$port"
}

# --- Everyday commands ------------------------------------------------------------

# Pulls a service's image; when that fails, a copy already on this machine is used.
function Get-ServiceImage([string]$Service) {
  & docker compose pull -q $Service
  if ($LASTEXITCODE -ne 0) { Write-Warning "couldn't download the image for $Service; using the copy on this machine, if there is one" }
}

function Invoke-Up([string[]]$Rest) {
  Assert-Installed
  Get-ServiceImage keel-migrate
  Get-ServiceImage keel-functions
  Invoke-Docker compose up -d @Rest
  Write-Host ''
  Write-Host "Keel is starting. Studio: $(Get-StudioUrl)"
}

function Invoke-Down([string[]]$Rest) {
  Assert-Installed
  if ($Rest -contains '-v' -or $Rest -contains '--volumes') {
    Write-Host 'This deletes the Docker volume that holds every database (the nightly dumps in backups\ stay).'
    if (-not (Read-YesNo 'Delete every database?' $false)) { Exit-Keel 'nothing was changed' }
  }
  Invoke-Docker compose down @Rest
}

function Invoke-Psql([string[]]$Rest) {
  Assert-Installed
  $project = ''
  for ($i = 0; $i -lt $Rest.Count; $i++) {
    if ($Rest[$i] -in '--project', '-p') { $project = $Rest[$i + 1]; $i++ }
    elseif ($Rest[$i].StartsWith('--project=')) { $project = $Rest[$i].Substring(10) }
    else { $project = $Rest[$i] }
  }
  if (-not $project) { $project = Get-EnvValue KEEL_DEFAULT_PROJECT }
  if (-not $project) { $project = 'postgres' }
  $tty = @(); if ([Console]::IsInputRedirected) { $tty = @('-T') }
  & docker compose exec @tty keel-db psql -U postgres -d $project.Replace('-', '_')
  exit $LASTEXITCODE
}

# Runs a one-off command in the Keel image (uses the running database).
function Invoke-KeelRun([string[]]$Rest) {
  Assert-Installed
  & docker compose run --rm --no-deps -T @Rest
  exit $LASTEXITCODE
}

function Invoke-FunctionCommand([string[]]$Rest) {
  $sub = if ($Rest.Count) { $Rest[0] } else { '' }
  $dir = ''; $other = @()
  for ($i = 1; $i -lt $Rest.Count; $i++) {
    if ($Rest[$i] -eq '--dir') { $dir = $Rest[$i + 1]; $i++ } else { $other += $Rest[$i] }
  }
  switch ($sub) {
    'deploy' {
      if (-not $dir) {
        foreach ($d in 'supabase\functions', 'functions') {
          $candidate = Join-Path $script:OrigPwd $d
          # The install folder's own functions\ holds Keel's working copies, not your code.
          if ((Test-Path -LiteralPath $candidate -PathType Container) -and ($candidate -ne (Join-Path $PSScriptRoot 'functions'))) { $dir = $candidate; break }
        }
      } else { $dir = Get-FullPath $dir }
      if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) {
        Exit-Keel 'no functions folder found. Run this next to supabase\functions, or pass --dir PATH'
      }
      $mounts = @('-v', "${dir}:/src/functions:ro")
      $config = Join-Path (Split-Path -Parent $dir) 'config.toml'
      if (Test-Path -LiteralPath $config) { $mounts += @('-v', "${config}:/src/config.toml:ro") }
      Invoke-KeelRun (@($mounts) + @('keel-migrate', 'fn', 'deploy') + $other)
    }
    { $_ -in 'list', 'delete' } { Invoke-KeelRun (@('keel-migrate', 'fn', $sub) + $other) }
    default { Exit-Keel 'usage: keel functions <deploy|list|delete> [name ...] [--project NAME] [--dir PATH] [--no-verify-jwt]' }
  }
}

function Invoke-SecretCommand([string[]]$Rest) {
  $sub = if ($Rest.Count) { $Rest[0] } else { '' }
  $other = @()
  for ($i = 1; $i -lt $Rest.Count; $i++) {
    if ($Rest[$i] -eq '--env-file') {
      $file = Get-FullPath $Rest[$i + 1]; $i++
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Exit-Keel "no such file: $file" }
      foreach ($line in [IO.File]::ReadAllLines($file)) {
        $line = $line.TrimEnd("`r")
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7) }
        $k = $line.Split('=', 2)[0]; $v = if ($line.Contains('=')) { $line.Split('=', 2)[1] } else { '' }
        foreach ($q in '"', "'") { if ($v.StartsWith($q)) { $v = $v.Substring(1) }; if ($v.EndsWith($q)) { $v = $v.Substring(0, $v.Length - 1) } }
        $other += "$k=$v"
      }
    } else { $other += $Rest[$i] }
  }
  if ($sub -notin 'list', 'set', 'unset') { Exit-Keel 'usage: keel secrets <list|set NAME=value ...|unset NAME ...> [--env-file FILE] [--project NAME]' }
  Invoke-KeelRun (@('keel-migrate', 'secrets', $sub) + $other)
}

# --- Versions, backups, update and rollback ---------------------------------------
#
# The same as the bash keel command: an update moves between version tags
# (KEEL_VERSION in .env) and remembers the one it came from
# (KEEL_PREVIOUS_VERSION). Before it changes anything it dumps every database
# into backups\pre-update\<time>\, so `keel rollback --restore` can undo schema
# upgrades.

function Get-PgUser { $u = Get-EnvValue POSTGRES_USER; if ($u) { return $u } else { return 'postgres' } }

function Get-DbQuery([string]$Db, [string]$Sql) {
  return Get-DockerOutput compose exec -T keel-db psql -U (Get-PgUser) -X -At -v ON_ERROR_STOP=1 -d $Db -c $Sql
}

# Starts keel-db if needed and waits until it answers.
function Wait-Database {
  if (-not (Get-DockerOutput compose ps -q --status running keel-db)) {
    & docker compose up -d --no-deps keel-db | Out-Null
  }
  for ($i = 0; $i -lt 60; $i++) {
    if ($null -ne (Get-DockerOutput compose exec -T keel-db pg_isready -q -U (Get-PgUser))) { return }
    Start-Sleep -Seconds 2
  }
  Exit-Keel "the database (keel-db) didn't start; see keel logs keel-db"
}

# Every database except the templates and postgres: the projects and Keel's own.
function Get-DatabaseName {
  $out = Get-DbQuery postgres "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1"
  if ($null -eq $out) { Exit-Keel "couldn't list the databases" }
  return @($out -split "`n" | Where-Object { $_ })
}

# One line per database with its highest schema upgrade, as the bash keel writes it.
function Get-SchemaLevel {
  $lines = foreach ($db in Get-DatabaseName) {
    if ((Get-DbQuery $db "select to_regclass('_keel.migrations') is not null") -eq 't') {
      "$db=$(Get-DbQuery $db 'select coalesce(max(version), 0) from _keel.migrations')"
    } elseif ((Get-DbQuery $db "select to_regclass('keel.schema_state') is not null") -eq 't') {
      "$db=control:$(Get-DbQuery $db "select project_migration || '/' || control_schema from keel.schema_state")"
    } else { "$db=-" }
  }
  return (@($lines) -join "`n")
}

# The repository of the keel image in the compose file, e.g. ghcr.io/me/keel.
function Get-KeelRepo {
  $images = Get-DockerOutput compose config --images
  foreach ($line in @($images -split "`n")) { if ($line -match '^(.*/keel):') { return $Matches[1] } }
  return ''
}

function Get-ImageVersion([string]$Image) {
  $json = Get-DockerOutput image inspect --format '{{json .Config.Labels}}' $Image
  if (-not $json -or $json -eq 'null') { return '' }
  $labels = $json | ConvertFrom-Json
  $v = $labels.PSObject.Properties['org.opencontainers.image.version']
  if ($v) { return [string]$v.Value } else { return '' }
}

# The version running now: KEEL_VERSION when it's a version, else the version
# label of the image in use.
function Get-CurrentVersion {
  $v = Get-EnvValue KEEL_VERSION
  if (Test-KeelVersion $v) { return $v }
  $img = ''
  $id = Get-DockerOutput compose ps -a -q keel-migrate
  if ($id) { $img = Get-DockerOutput inspect --format '{{.Image}}' ($id -split "`n")[0] }
  if (-not $img) { $tag = if ($v) { $v } else { 'latest' }; $img = "$(Get-KeelRepo):$tag" }
  $v = Get-ImageVersion $img
  if (Test-KeelVersion $v) { return $v } else { return '' }
}

function Get-LatestRelease {
  $repo = Get-KeelRepo
  if (-not $repo) { Exit-Keel "can't find the keel image in docker-compose.yml" }
  & docker pull -q "${repo}:latest" | Out-Null
  if ($LASTEXITCODE -ne 0) { Exit-Keel "could not download ${repo}:latest" }
  $v = Get-ImageVersion "${repo}:latest"
  if (-not (Test-KeelVersion $v)) { Exit-Keel "couldn't tell which version ${repo}:latest is; pass --version (e.g. --version 0.2.0)" }
  return $v
}

# Tags the images in use as "previous", for a rollback when their version isn't known.
function Save-PreviousImage {
  $repo = Get-KeelRepo
  $tag = Get-EnvValue KEEL_VERSION; if (-not $tag) { $tag = 'latest' }
  foreach ($name in $repo, "$repo-functions") {
    & docker tag "${name}:$tag" "${name}:previous"
    if ($LASTEXITCODE -ne 0) { Exit-Keel "couldn't keep a copy of ${name}:$tag for a rollback" }
  }
}

# Copies a file out of keel-db and removes it there.
function Copy-FromDatabase([string]$Inside, [string]$Outside) {
  & docker compose cp "keel-db:$Inside" $Outside | Out-Null
  $ok = $LASTEXITCODE -eq 0
  Get-DockerOutput compose exec -T keel-db rm -f $Inside | Out-Null
  return $ok
}

# Dumps every database into a new folder under backups\pre-update.
function Backup-Database([string]$From, [string]$To) {
  Wait-Database
  New-Item -ItemType Directory -Force -Path $script:PreUpdateDir | Out-Null
  # Enough room for the dumps (they are compressed; the databases' size is a safe bound).
  $totalKb = [long](Get-DbQuery postgres 'select coalesce(sum(pg_database_size(datname)), 0) / 1024 from pg_database where not datistemplate')
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot((Resolve-Path $script:PreUpdateDir).Path))
  if ($drive.AvailableFreeSpace / 1024 -lt $totalKb) {
    Exit-Keel "not enough free disk space for a backup before the update (need about $([math]::Ceiling($totalKb / 1024)) MB); free some space, or run with --no-backup"
  }
  $dir = Join-Path $script:PreUpdateDir (Get-Date -Format 'yyyyMMdd-HHmmss')
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Protect-KeelFile $dir
  $full = (Resolve-Path $dir).Path
  Write-Host "Backing up every database to $dir ..."
  foreach ($db in Get-DatabaseName) {
    $inside = "/tmp/keel-backup-$db.dump"
    & docker compose exec -T keel-db pg_dump -U (Get-PgUser) -Fc -f $inside $db
    if ($LASTEXITCODE -ne 0 -or -not (Copy-FromDatabase $inside (Join-Path $full "$db.dump"))) {
      Remove-Item -Recurse -Force -LiteralPath $full; Exit-Keel "backup of $db failed; nothing was changed"
    }
    if ((Get-Item -LiteralPath (Join-Path $full "$db.dump")).Length -eq 0) {
      Remove-Item -Recurse -Force -LiteralPath $full; Exit-Keel "backup of $db is empty; nothing was changed"
    }
  }
  # Roles and their password hashes, for recovery by hand (not restored automatically).
  & docker compose exec -T keel-db pg_dumpall -U (Get-PgUser) --globals-only -f /tmp/keel-globals.sql
  if ($LASTEXITCODE -eq 0) { Copy-FromDatabase /tmp/keel-globals.sql (Join-Path $full 'globals.sql') | Out-Null }
  Write-Utf8File (Join-Path $full 'schema') ((Get-SchemaLevel) + "`n")
  foreach ($f in 'docker-compose.yml', 'docker-compose.windows.yml') {
    if (Test-Path -LiteralPath $f) { Copy-Item -LiteralPath $f -Destination $full }
  }
  Write-Utf8File (Join-Path $full 'about') ("from=$From`nto=$To`ntime=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))`n")
  # Keep the newest few.
  Get-ChildItem -LiteralPath $script:PreUpdateDir -Directory | Sort-Object Name -Descending |
    Select-Object -Skip $script:KeepPreUpdate | ForEach-Object { Remove-Item -Recurse -Force -LiteralPath $_.FullName }
  Write-Host "Backup done: $dir"
}

function Get-NewestBackupSet {
  if (-not (Test-Path -LiteralPath $script:PreUpdateDir)) { return '' }
  $newest = Get-ChildItem -LiteralPath $script:PreUpdateDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
  if ($newest) { return Join-Path $script:PreUpdateDir $newest.Name } else { return '' }
}

function Get-AboutValue([string]$Set, [string]$Key) {
  $f = Join-Path $Set 'about'
  if (-not (Test-Path -LiteralPath $f)) { return '' }
  foreach ($line in [IO.File]::ReadAllLines((Resolve-Path $f).Path)) { if ($line.StartsWith("$Key=")) { return $line.Substring($Key.Length + 1) } }
  return ''
}

# Replaces every database in the backup set with its dump. Keel's services
# are stopped first; keel-db keeps running.
function Restore-Database([string]$Set) {
  & docker compose stop | Out-Null
  Wait-Database
  foreach ($f in Get-ChildItem -LiteralPath $Set -Filter '*.dump' -File) {
    $db = $f.BaseName
    Write-Host "Restoring $db ..."
    & docker compose exec -T keel-db dropdb -U (Get-PgUser) --if-exists --force $db
    & docker compose cp $f.FullName keel-db:/tmp/keel-restore.dump | Out-Null
    if ($LASTEXITCODE -ne 0) { Exit-Keel "couldn't copy $($f.Name) into keel-db" }
    & docker compose exec -T keel-db pg_restore -U (Get-PgUser) -d postgres --create --exit-on-error /tmp/keel-restore.dump
    $ok = $LASTEXITCODE -eq 0
    Get-DockerOutput compose exec -T keel-db rm -f /tmp/keel-restore.dump | Out-Null
    if (-not $ok) { Exit-Keel "restoring $db failed. The dumps are in $Set; see the backups guide to restore them by hand." }
  }
}

function Get-ContainerHealth([string]$Service) {
  $id = Get-DockerOutput compose ps -q $Service
  if (-not $id) { return '' }
  return Get-DockerOutput inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' ($id -split "`n")[0]
}

# Waits until Studio answers (or Docker reports Studio and the gateway healthy).
function Wait-Keel {
  $port = Get-EnvValue KEEL_STUDIO_PORT; if (-not $port) { $port = '3000' }
  Write-Host 'Waiting for Keel to start (up to 5 minutes)...'
  for ($i = 0; $i -lt 100; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/health"
      if ($r.StatusCode -eq 200) { return $true }
    } catch { Write-Verbose 'not answering yet' }
    if ((Get-ContainerHealth keel-studio) -eq 'healthy' -and (Get-ContainerHealth keel-gateway) -eq 'healthy') { return $true }
    Start-Sleep -Seconds 3
  }
  & docker compose ps -a
  Write-Host 'keel: last log lines of the migrations and Studio:'
  & docker compose logs --tail 20 keel-migrate keel-studio
  return $false
}

# Settings newer versions need, added with fresh values from the new image.
function Add-MissingSetting([string]$Image) {
  $fresh = Get-DockerOutput run --rm $Image generate-env
  if (-not $fresh) { return }
  foreach ($key in 'KEEL_SERVICE_PASSWORD', 'KEEL_FUNCTIONS_TOKEN', 'IMGPROXY_KEY', 'IMGPROXY_SALT') {
    if (-not (Get-EnvValue $key)) {
      $line = @($fresh -split "`n" | Where-Object { $_.StartsWith("$key=") })[0]
      if ($line) { Write-EnvValue $key $line.Substring($key.Length + 1).Trim(); Write-Host "Added $key to .env" }
    }
  }
}

function Invoke-Update([string[]]$Rest) {
  $target = ''; $backup = $true; $composeNew = ''
  for ($i = 0; $i -lt $Rest.Count; $i++) {
    switch ($Rest[$i]) {
      '--version' { $target = $Rest[$i + 1]; $i++ }
      '--no-backup' { $backup = $false }
      { $_ -in '--yes', '-y' } { $script:AssumeYes = $true }
      # Used by the installer: the new compose file, put in place after the backup.
      '--compose' { $composeNew = $Rest[$i + 1]; $i++ }
      default { Exit-Keel "unknown option $($Rest[$i]) (use --version V, --no-backup, --yes)" }
    }
  }
  Assert-Installed
  if (-not $target) { $target = '' }

  $cur = Get-CurrentVersion
  # An install whose version isn't known keeps its images as "previous" before
  # anything is downloaded (finding the newest release moves the latest tag).
  if (-not $cur) { Save-PreviousImage; $prev = 'previous' } else { $prev = $cur }
  $target = $target -replace '^v', ''
  if ($target -eq 'latest') { $target = '' }
  if (-not $target) {
    if ((Get-EnvValue KEEL_VERSION) -eq 'edge') { $target = 'edge' } else { $target = Get-LatestRelease }
  }
  if (-not (Test-KeelVersion $target) -and $target -ne 'edge') { Exit-Keel '--version: use a version such as 0.2.0' }
  if ((Test-KeelVersion $cur) -and (Test-KeelVersion $target) -and (Test-VersionLower $target $cur)) {
    Exit-Keel "$target is older than the version running now ($cur). To go back, use keel rollback."
  }
  if ($target -eq $cur -and -not $composeNew) {
    Write-Host "Keel $cur is already running; restarting it."
    Invoke-Up @()
    return
  }

  $repo = Get-KeelRepo
  $was = if ($cur) { $cur } else { 'an unversioned build' }
  Write-Host "Updating Keel from $was to $target."
  # Download first: if that fails, nothing has changed.
  foreach ($name in $repo, "$repo-functions") {
    & docker pull -q "${name}:$target" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      # A version that only exists on this machine (built or loaded locally) is fine too.
      if ($null -eq (Get-DockerOutput image inspect "${name}:$target")) { Exit-Keel "could not download ${name}:$target; nothing was changed" }
      Write-Warning "couldn't download ${name}:$target; using the copy on this machine"
    }
  }
  if ($backup) { Backup-Database $prev $target }
  if ($composeNew) {
    Move-Item -LiteralPath $composeNew -Destination docker-compose.yml -Force
    if (Test-Path -LiteralPath docker-compose.windows.yml.new) { Move-Item -LiteralPath docker-compose.windows.yml.new -Destination docker-compose.windows.yml -Force }
  }
  Add-MissingSetting "${repo}:$target"
  # Refreshing the same version (the installer) keeps the recorded previous one.
  if ($target -ne $cur) { Write-EnvValue KEEL_PREVIOUS_VERSION $prev }
  Write-EnvValue KEEL_VERSION $target
  # The other images (Postgres, imgproxy) are pinned in the compose file.
  Get-DockerOutput compose pull -q --ignore-pull-failures | Out-Null
  & docker compose up -d --remove-orphans
  if ($LASTEXITCODE -ne 0 -or -not (Wait-Keel)) {
    Write-Host ''
    Exit-Keel "Keel $target didn't start. To go back to $prev, run: .\keel rollback"
  }
  Write-Host ''
  Write-Host "Keel is now $target (was $prev). If something is wrong, .\keel rollback goes back."
}

function Invoke-Rollback([string[]]$Rest) {
  $restore = ''
  foreach ($a in $Rest) {
    switch ($a) {
      '--restore' { $restore = 'yes' }
      '--no-restore' { $restore = 'no' }
      { $_ -in '--yes', '-y' } { $script:AssumeYes = $true }
      default { Exit-Keel "unknown option $a (use --restore, --no-restore, --yes)" }
    }
  }
  Assert-Installed
  $set = Get-NewestBackupSet
  $prev = Get-EnvValue KEEL_PREVIOUS_VERSION
  $cur = Get-EnvValue KEEL_VERSION
  if (-not $prev) { Exit-Keel 'no previous version is recorded in .env (KEEL_PREVIOUS_VERSION); updates made with keel update record it' }

  # Did the newer version upgrade the schema? Then the older one won't start
  # on it (keel-migrate refuses), and the backup has to come back.
  if (-not $restore) {
    if (-not $set) {
      Write-Host "No backup from before the update was found in $script:PreUpdateDir. If the newer version"
      Write-Host 'upgraded the database, the older one will refuse to start.'
      $restore = 'no'
    } else {
      Wait-Database
      $saved = ''
      if (Test-Path -LiteralPath (Join-Path $set 'schema')) { $saved = [IO.File]::ReadAllText((Resolve-Path (Join-Path $set 'schema')).Path).Trim() }
      if ((Get-SchemaLevel).Trim() -eq $saved) {
        $restore = 'no'
      } else {
        Write-Host "Since the backup of $(Get-AboutValue $set 'time') ($set), the database schema changed:"
        Write-Host 'the newer version upgraded it, so the older one can''t run on it.'
        if (Read-YesNo 'Restore every database from that backup? Changes made since then are lost.' $false) {
          $restore = 'yes'
        } else {
          Exit-Keel 'nothing was changed. Run .\keel rollback --restore to restore the backup, or stay on this version.'
        }
      }
    }
  } elseif ($restore -eq 'yes') {
    if (-not $set) { Exit-Keel "there is no backup in $script:PreUpdateDir to restore" }
    Write-Host "This replaces every database with the backup of $(Get-AboutValue $set 'time') ($set)."
    if (-not (Read-YesNo 'Changes made since then are lost. Continue?' $false)) { Exit-Keel 'nothing was changed' }
  }

  $repo = Get-KeelRepo
  if ($prev -ne 'previous') {
    foreach ($name in $repo, "$repo-functions") {
      & docker pull -q "${name}:$prev" | Out-Null
      if ($LASTEXITCODE -ne 0 -and $null -eq (Get-DockerOutput image inspect "${name}:$prev")) {
        Exit-Keel "could not download ${name}:$prev; nothing was changed"
      }
    }
  } elseif ($null -eq (Get-DockerOutput image inspect "${repo}:previous")) {
    Exit-Keel 'the previous images are no longer on this machine'
  }
  if ($restore -eq 'yes') {
    Restore-Database $set
    foreach ($f in 'docker-compose.yml', 'docker-compose.windows.yml') {
      $saved = Join-Path $set $f
      if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $f -Force }
    }
  }
  Write-EnvValue KEEL_VERSION $prev
  Write-EnvValue KEEL_PREVIOUS_VERSION $cur
  Invoke-Docker compose up -d --remove-orphans
  if (-not (Wait-Keel)) { Exit-Keel "Keel $prev didn't start; see the messages above" }
  Write-Host ''
  $what = if ($prev -eq 'previous') { 'the version from before the update' } else { $prev }
  $with = if ($restore -eq 'yes') { ", with the databases from $set" } else { '' }
  Write-Host "Keel is back on $what$with."
}

# --- Full backups -------------------------------------------------------------------
#
# keel restore --list shows the full backups here and in the off-machine
# target; keel restore <file or name> puts one back: every database and
# uploaded file of this install is replaced. The passphrase and the target's
# keys reach the container through the environment, never a command line.
# A file on this machine is mounted into the container, not piped (Windows
# PowerShell 5.1 would mangle its bytes in a pipe).

# The passphrase typed in, or '' when there's no one to ask.
function Read-Passphrase {
  if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return '' }
  $secure = Read-Host 'Backup passphrase' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Restore([string[]]$Rest) {
  $arg = ''; $list = $false; $verify = $false
  foreach ($a in $Rest) {
    if ($a -eq '--list') { $list = $true }
    elseif ($a -eq '--verify') { $verify = $true }
    elseif ($a -in '--yes', '-y') { $script:AssumeYes = $true }
    elseif ($a.StartsWith('-')) { Exit-Keel "unknown option $a (use --list, --verify, --yes)" }
    elseif ($arg) { Exit-Keel 'one backup at a time' }
    else { $arg = $a }
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Exit-Keel 'Docker is required: start Docker Desktop' }
  if (Test-Path -LiteralPath Dockerfile) { Exit-Keel 'this is a copy of the source code: use the bash keel command (Git Bash or WSL) here' }
  if (-not (Test-Path -LiteralPath .env)) { Exit-Keel 'no .env here. Install Keel first (a fresh install is fine), then restore into it.' }
  if (-not $list -and -not $arg) { Exit-Keel 'usage: .\keel restore --list | .\keel restore <backup file or name> [--verify] [--yes]' }

  $pass = Get-EnvValue KEEL_BACKUP_PASSPHRASE
  if (-not $pass -and -not $list) {
    $pass = Read-Passphrase
    if (-not $pass) { Exit-Keel 'set KEEL_BACKUP_PASSPHRASE in .env to the passphrase the backup was made with' }
  }
  # docker compose run -e NAME (without a value) passes this process's value on.
  # Set with .NET, not Set-Item, so PowerShell module logging never records a
  # value, and cleared again at the end (in case this script was run in an
  # open PowerShell session rather than through keel.cmd).
  $names = @('KEEL_BACKUP_PASSPHRASE', 'KEEL_SECRET', 'KEEL_RESTORE_NAME')
  [Environment]::SetEnvironmentVariable('KEEL_BACKUP_PASSPHRASE', $pass, 'Process')
  [Environment]::SetEnvironmentVariable('KEEL_SECRET', (Get-EnvValue KEEL_SECRET), 'Process')
  $envs = @('-e', 'KEEL_BACKUP_PASSPHRASE', '-e', 'KEEL_SECRET')
  foreach ($k in 'ENDPOINT', 'REGION', 'BUCKET', 'PREFIX', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'PATH_STYLE') {
    $names += "KEEL_BACKUP_S3_$k"
    [Environment]::SetEnvironmentVariable("KEEL_BACKUP_S3_$k", (Get-EnvValue "KEEL_BACKUP_S3_$k"), 'Process')
    $envs += @('-e', "KEEL_BACKUP_S3_$k")
  }
  try {
    Wait-Database
    if ($list) {
      & docker compose run --rm --no-deps -T @envs keel-migrate restore --list
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      return
    }

    # A file on this machine is mounted into the container; anything else is a name.
    $mounts = @(); $target = $arg
    $file = Get-FullPath $arg
    if (Test-Path -LiteralPath $file -PathType Leaf) {
      $mounts = @('-v', "${file}:/restore/backup.tar.age:ro")
      $target = '/restore/backup.tar.age'
      # Its own name, so the restore can warn when it doesn't match the backup inside.
      [Environment]::SetEnvironmentVariable('KEEL_RESTORE_NAME', [IO.Path]::GetFileName($file), 'Process')
      $envs += @('-e', 'KEEL_RESTORE_NAME')
    }
    & docker compose run --rm --no-deps -T @mounts @envs keel-migrate restore $target --verify-only
    if ($LASTEXITCODE -ne 0) { Exit-Keel 'nothing was changed' }
    if ($verify) { return }

    Write-Host ''
    Write-Host 'This replaces every database and uploaded file of this Keel with the backup.'
    if (-not (Read-YesNo 'Everything changed here since the backup was made is lost. Continue?' $false)) { Exit-Keel 'nothing was changed' }
    # A name was downloaded into backups\full by the check above.
    Write-Host 'Stopping Keel ...'
    & docker compose stop | Out-Null
    Wait-Database
    & docker compose run --rm --no-deps -T @mounts @envs keel-migrate restore $target --checked
    if ($LASTEXITCODE -ne 0) {
      Exit-Keel 'the restore stopped part way. Fix the problem above and run .\keel restore again; Keel stays stopped until then.'
    }
    Write-Host 'Starting Keel ...'
    Invoke-Docker compose up -d --remove-orphans
    if (-not (Wait-Keel)) { Exit-Keel "Keel didn't start after the restore; see the messages above" }
    Write-Host ''
    Write-Host 'Restored. Apps keep working with the same API keys, and Studio has the accounts from the backup.'
    Write-Host 'If KEEL_SECRET in .env differs from the old server''s, Studio two-factor sign-in and a target saved'
    Write-Host 'in Studio need setting up again; a Cloudflare tunnel token needs pasting again in Studio.'
  } finally {
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $null, 'Process') }
  }
}

function Show-Version {
  Assert-Installed
  $v = Get-CurrentVersion
  if (-not $v) { $v = 'unknown' }
  Write-Host "Keel $v (KEEL_VERSION=$(Get-EnvValue KEEL_VERSION))"
  $p = Get-EnvValue KEEL_PREVIOUS_VERSION
  if ($p) { Write-Host "Previous: $p (.\keel rollback)" }
}

function Show-Usage {
  Write-Host @'
Usage: .\keel <command>      (in the install folder, e.g. cd $HOME\keel)

  up                                  Start Keel (and apply changes to .env)
  down                                Stop Keel (data is kept)
  ps                                  Show container status
  logs [service]                      Follow logs (e.g. .\keel logs keel-auth)
  psql [project]                      psql into a project's database (default: KEEL_DEFAULT_PROJECT)
  functions deploy [name ...]         Deploy edge functions from .\supabase\functions
            [--project P] [--dir PATH] [--no-verify-jwt]
  functions list|delete [name]        List or delete deployed functions
  secrets set NAME=value ...          Set environment variables for functions
          [--env-file FILE] [--project P]   (also: secrets list, secrets unset NAME)
  import-supabase --db-url URL        Copy a Supabase project (tables, users, files)
          [--url URL --service-key KEY] [--project P]   into a Keel project
  studio-user list|add|reset-password|reset-2fa|remove [name]
                                      Manage Studio accounts (recovery, lost phone)
  keys list|roll|revoke-old <project>  Show or roll a project's API keys
  update [--version V] [--no-backup]  Back up every database, then move to the newest
                                      release (or version V) and restart
  rollback [--restore]                Go back to the version before the last update;
                                      --restore also puts back the databases from
                                      the backup taken before it
  restore --list                      Show the full backups here and in the backup target
  restore <file or name> [--verify]   Replace every database and uploaded file with a
          [--yes]                     full backup (--verify only checks it)
  version                             Show the version running and the previous one
'@
}

# --- Main ---------------------------------------------------------------------------

$command = if ($args.Count) { [string]$args[0] } else { '' }
$rest = @(); if ($args.Count -gt 1) { $rest = @($args[1..($args.Count - 1)] | ForEach-Object { [string]$_ }) }
try {
  switch ($command) {
    'up' { Invoke-Up $rest }
    'down' { Invoke-Down $rest }
    'ps' { Assert-Installed; & docker compose ps; exit $LASTEXITCODE }
    'logs' { Assert-Installed; & docker compose logs -f --tail=200 @rest; exit $LASTEXITCODE }
    'psql' { Invoke-Psql $rest }
    { $_ -in 'functions', 'fn' } { Invoke-FunctionCommand $rest }
    'secrets' { Invoke-SecretCommand $rest }
    'studio-user' { Invoke-KeelRun (@('keel-migrate', 'studio-user') + $rest) }
    'keys' { Invoke-KeelRun (@('keel-migrate', 'keys') + $rest) }
    'import-supabase' {
      if (-not $rest.Count) { Exit-Keel "usage: .\keel import-supabase --db-url 'postgresql://...' [--url https://<ref>.supabase.co --service-key KEY] [--project NAME]" }
      Invoke-KeelRun (@('keel-migrate', 'import-supabase') + $rest)
    }
    'update' { Invoke-Update $rest }
    'rollback' { Invoke-Rollback $rest }
    'restore' { Invoke-Restore $rest }
    { $_ -in 'version', '--version' } { Show-Version }
    { $_ -in '', '-h', '--help', 'help' } { Show-Usage }
    default { Show-Usage; exit 1 }
  }
} catch [KeelError] {
  [Console]::Error.WriteLine("keel: $($_.Exception.Message)")
  exit 1
}
exit 0
