# Runs install.ps1 end to end with a stand-in docker (tests/installer/fake-docker),
# so it works on CI runners without Linux containers. Checks that both scripts
# parse, a dry run, a new install and the .env it writes, the keel command
# (including how keel restore handles its arguments and secrets), and that a
# tampered download is refused. Run it in Windows PowerShell 5.1 (what Windows ships):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\installer\test-install-ps1.ps1
#
# Needs Node 22.18 or newer (to write the install files).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('keel-installer-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
function Fail([string]$Message) { throw "FAIL: $Message" }
function Pass([string]$Message) { Write-Host "ok - $Message" }

try {
  Write-Host "PowerShell $($PSVersionTable.PSVersion)"
  foreach ($f in 'deploy\install.ps1', 'deploy\windows\keel-cli.ps1') {
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $f), [ref]$null, [ref]$errors) | Out-Null
    if ($errors.Count) { Fail "$f doesn't parse: $($errors[0].Message) (line $($errors[0].Extent.StartLineNumber))" }
    if (@([IO.File]::ReadAllBytes((Join-Path $root $f)) | Where-Object { $_ -gt 127 }).Count) { Fail "$f isn't plain ASCII (PowerShell 5.1 would misread it)" }
  }
  Pass 'install.ps1 and keel-cli.ps1 parse and are ASCII'

  # The installer and the files it downloads, served from a folder (file:// URLs).
  $files = Join-Path $tmp 'files'
  $env:KEEL_FILES_URL = ([Uri]$files).AbsoluteUri
  $env:KEEL_RELEASE_VERSION = '0.0.1-test'
  $env:KEEL_IMAGE_PREFIX = 'ghcr.io/example'
  $env:KEEL_SITE_URL = 'https://keel.example.com'
  & node (Join-Path $root 'tests\installer\install-files.mjs') $files | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'could not write the install files' }
  $env:PATH = (Join-Path $PSScriptRoot 'fake-docker') + ';' + $env:PATH
  $env:FAKE_DOCKER_LOG = Join-Path $tmp 'docker.log'
  foreach ($v in 'KEEL_DIR', 'KEEL_VERSION', 'KEEL_PUBLIC_URL', 'KEEL_HOST', 'KEEL_LAN', 'KEEL_DB_LAN', 'KEEL_YES', 'KEEL_PROJECT_NAME') { Remove-Item "env:$v" -ErrorAction SilentlyContinue }
  $installer = Join-Path $files 'install.ps1'
  $ports = @('-GatewayPort', '28000', '-StudioPort', '23000', '-DbPort', '25432')

  # 1. A dry run changes nothing.
  $dir = Join-Path $tmp 'keel'
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Dir $dir -Yes -DryRun @ports 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Write-Host $out; Fail 'the dry run failed' }
  if ($out -notmatch 'The files check out') { Write-Host $out; Fail 'the dry run did not check the files' }
  if (Test-Path -LiteralPath $dir) { Fail 'the dry run created the install folder' }
  Pass 'dry run'

  # 2. A new install.
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Dir $dir -Yes -NoLan -HostName keel-test.local @ports 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $out -notmatch 'Keel is running') { Write-Host $out; Fail 'install failed' }
  if ($out -notmatch 'admin / FakePassword12345678') { Fail "the login isn't shown" }
  $envText = [IO.File]::ReadAllText((Join-Path $dir '.env'))
  if ($envText.Contains("`r")) { Fail '.env has CRLF line endings' }
  if ([IO.File]::ReadAllBytes((Join-Path $dir '.env'))[0] -eq 0xEF) { Fail '.env starts with a byte order mark' }
  foreach ($key in 'KEEL_PUBLIC_URL', 'KEEL_VERSION', 'POSTGRES_PASSWORD', 'KEEL_SERVICE_PASSWORD', 'KEEL_SECRET', 'KEEL_FUNCTIONS_TOKEN',
    'KEEL_DASHBOARD_PASSWORD', 'IMGPROXY_KEY', 'IMGPROXY_SALT', 'KEEL_STUDIO_BIND', 'KEEL_DB_BIND', 'KEEL_DB_GATEWAY', 'COMPOSE_FILE') {
    if ($envText -notmatch "(?m)^$key=.") { Fail ".env has no $key" }
  }
  foreach ($line in 'KEEL_VERSION=0.0.1-test', 'KEEL_PUBLIC_URL=http://keel-test.local:28000', 'KEEL_STUDIO_BIND=127.0.0.1',
    'KEEL_DB_BIND=127.0.0.1', 'KEEL_STUDIO_PORT=23000', 'COMPOSE_FILE=docker-compose.yml;docker-compose.windows.yml') {
    if ($envText -notmatch "(?m)^$([regex]::Escape($line))$") { Fail ".env should have $line" }
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath (Join-Path $dir '.env')
  if (-not $acl.AreAccessRulesProtected) { Fail '.env inherits permissions from its folder' }
  foreach ($rule in $acl.Access) {
    $who = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($who -notin $sid, 'S-1-5-18', 'S-1-5-32-544') { Fail ".env is readable by $($rule.IdentityReference)" }
  }
  $acl = Get-Acl -LiteralPath $dir
  if (-not $acl.AreAccessRulesProtected) { Fail 'the install folder inherits permissions from its parent' }
  foreach ($rule in $acl.Access) {
    $who = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($who -notin $sid, 'S-1-5-18', 'S-1-5-32-544') { Fail "the install folder is open to $($rule.IdentityReference)" }
  }
  foreach ($f in 'docker-compose.yml', 'docker-compose.windows.yml', 'keel-cli.ps1', 'keel.cmd') {
    if ((Get-FileHash (Join-Path $dir $f)).Hash -ne (Get-FileHash (Join-Path $files $f)).Hash) { Fail "$f differs from the published one" }
  }
  foreach ($d in 'db-tls', 'storage', 'backups', 'functions', 'tunnel') { if (-not (Test-Path -LiteralPath (Join-Path $dir $d))) { Fail "no $d folder" } }
  if (-not (Select-String -LiteralPath $env:FAKE_DOCKER_LOG -Pattern '^docker compose up -d$' -Quiet)) { Fail "Keel wasn't started" }
  Pass 'new install'

  # 3. The keel command runs through keel.cmd, whatever the execution policy.
  $out = & (Join-Path $dir 'keel.cmd') version 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $out -notmatch 'Keel 0\.0\.1-test') { Write-Host $out; Fail 'keel version failed' }
  & (Join-Path $dir 'keel.cmd') no-such-command *> $null
  if ($LASTEXITCODE -ne 1) { Fail 'an unknown command should exit with 1' }
  Pass 'keel command'

  # 4. keel restore: arguments, and the passphrase and target keys reach the
  # container through the environment only. Input is piped in, so nobody can
  # answer a question (as in a scheduled task).
  $keel = Join-Path $dir 'keel.cmd'
  function Invoke-KeelRestore([string[]]$KeelArgs) {
    Set-Content -LiteralPath $env:FAKE_DOCKER_LOG -Value '' -Encoding Ascii
    # Windows PowerShell 5.1 turns a native command's stderr into errors.
    $ErrorActionPreference = 'Continue'
    $script:out = '' | & $keel restore @KeelArgs 2>&1 | Out-String
    $script:code = $LASTEXITCODE
    $script:log = [IO.File]::ReadAllText($env:FAKE_DOCKER_LOG)
  }
  foreach ($case in @(
      @{ Args = @(); Error = 'usage: .\\keel restore --list' },
      @{ Args = @('--bogus'); Error = 'unknown option --bogus' },
      @{ Args = @('one.tar.age', 'two.tar.age'); Error = 'one backup at a time' },
      @{ Args = @('keel-20261003-030000.tar.age'); Error = 'set KEEL_BACKUP_PASSPHRASE in \.env' })) {
    Invoke-KeelRestore $case.Args
    if ($code -ne 1 -or $out -notmatch $case.Error) { Write-Host $out; Fail "keel restore $($case.Args -join ' ') should stop with: $($case.Error)" }
    if ($log -match 'compose run') { Fail "keel restore $($case.Args -join ' ') ran something" }
  }
  Invoke-KeelRestore @('--list')
  if ($code -ne 0 -or $out -notmatch 'keel-20261003-030000\.tar\.age') { Write-Host $out; Fail 'keel restore --list failed' }
  if ($log -notmatch '(?m)^docker compose run --rm --no-deps -T -e KEEL_BACKUP_PASSPHRASE -e KEEL_SECRET -e KEEL_BACKUP_S3_ENDPOINT .*-e KEEL_BACKUP_S3_PATH_STYLE keel-migrate restore --list\r?$') {
    Write-Host $log; Fail 'keel restore --list ran the wrong command'
  }
  Add-Content -LiteralPath (Join-Path $dir '.env') -Value "`nKEEL_BACKUP_PASSPHRASE=test pass phrase 42`nKEEL_BACKUP_S3_BUCKET=test-bucket`nKEEL_BACKUP_S3_SECRET_ACCESS_KEY=test-s3-secret-key" -Encoding Ascii
  $backupFile = Join-Path $tmp 'keel-20261003-030000.tar.age'
  [IO.File]::WriteAllBytes($backupFile, [byte[]](0, 1, 2, 255))
  Push-Location $tmp
  try { Invoke-KeelRestore @('keel-20261003-030000.tar.age', '--verify') } finally { Pop-Location }
  if ($code -ne 0) { Write-Host $out; Fail 'keel restore <file> --verify failed' }
  if ($log -notmatch "(?m)^docker compose run --rm --no-deps -T -v $([regex]::Escape($backupFile)):/restore/backup\.tar\.age:ro -e KEEL_BACKUP_PASSPHRASE .*-e KEEL_RESTORE_NAME keel-migrate restore /restore/backup\.tar\.age --verify-only\r?$") {
    Write-Host $log; Fail 'a local file is not mounted, relative to the current folder, for the check'
  }
  if ($log -notmatch 'env KEEL_BACKUP_PASSPHRASE=test pass phrase 42 KEEL_SECRET=0011\S+ KEEL_BACKUP_S3_BUCKET=test-bucket KEEL_BACKUP_S3_SECRET_ACCESS_KEY=test-s3-secret-key KEEL_RESTORE_NAME=keel-20261003-030000\.tar\.age') {
    Write-Host $log; Fail "the passphrase, target and file name don't reach the container"
  }
  foreach ($secret in 'test pass phrase 42', 'test-s3-secret-key') {
    if (@($log -split "`n" | Where-Object { $_.StartsWith('docker ') -and $_.Contains($secret) }).Count) { Fail 'a secret is on a docker command line' }
  }
  if ($log -match '--checked|compose stop') { Fail '--verify changed something' }
  Invoke-KeelRestore @('keel-20261003-030000.tar.age')
  if ($code -ne 1 -or $out -notmatch 'nothing was changed') { Write-Host $out; Fail 'a restore nobody confirmed went ahead' }
  if ($log -notmatch 'keel-migrate restore keel-20261003-030000\.tar\.age --verify-only' -or $log -match '--checked|compose stop|-v ') { Write-Host $log; Fail 'a backup name was not checked, or something changed' }
  $env:FAKE_RESTORE_FAIL = '1'
  try { Invoke-KeelRestore @('keel-20261003-030000.tar.age', '--yes') } finally { Remove-Item env:FAKE_RESTORE_FAIL }
  if ($code -ne 1 -or $out -notmatch 'nothing was changed' -or $log -match '--checked|compose stop') { Write-Host $out; Fail 'a backup that failed its check was restored' }
  Invoke-KeelRestore @('keel-20261003-030000.tar.age', '--yes')
  if ($code -ne 0 -or $out -notmatch 'Restored\.') { Write-Host $out; Fail 'keel restore --yes failed' }
  $order = @($log -split "`n" | Where-Object { $_ -match '--verify-only|compose stop|--checked|compose up -d --remove-orphans' })
  if ($order.Count -ne 4 -or $order[0] -notmatch '--verify-only' -or $order[1] -notmatch 'compose stop' -or $order[2] -notmatch 'restore keel-20261003-030000\.tar\.age --checked' -or $order[3] -notmatch 'compose up') {
    Write-Host $log; Fail 'keel restore --yes should check, stop Keel, restore, then start Keel'
  }
  Pass 'keel restore'

  # 5. A download that doesn't match SHA256SUMS is refused, and nothing is written.
  Add-Content -LiteralPath (Join-Path $files 'docker-compose.yml') -Value '# tampered'
  $bad = Join-Path $tmp 'tampered'
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Dir $bad -Yes -NoLan @ports 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { Fail 'a tampered docker-compose.yml was accepted' }
  if ($out -notmatch "docker-compose.yml doesn't match its published checksum") { Write-Host $out; Fail 'wrong error for a tampered file' }
  if ((Test-Path -LiteralPath (Join-Path $bad 'docker-compose.yml')) -or (Test-Path -LiteralPath (Join-Path $bad '.env'))) { Fail 'files were written despite the bad checksum' }
  Pass 'tampered download refused'

  Write-Host 'all Windows installer tests passed'
} finally {
  Set-Location -LiteralPath $root
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
