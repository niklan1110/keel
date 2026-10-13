# Stands in for docker in the Windows installer test (GitHub's Windows runners
# have no Linux containers): answers the calls install.ps1 makes, starts
# nothing, and logs each call to $env:FAKE_DOCKER_LOG.
if ($env:FAKE_DOCKER_LOG) { Add-Content -LiteralPath $env:FAKE_DOCKER_LOG -Value ("docker " + ($args -join ' ')) }
$a = @($args | ForEach-Object { [string]$_ })
switch ($a[0]) {
  'info' { 'linux'; exit 0 }
  'compose' {
    switch ($a[1]) {
      'version' { 'Docker Compose version v2.30.0'; exit 0 }
      'ps' { if ($a[2] -eq '-q') { 'fake0000container' }; exit 0 }
      { $_ -in 'up', 'pull', 'logs', 'config', 'down', 'stop', 'exec' } { exit 0 }
      # One-off keel-migrate commands (keel restore): logs the settings that
      # reach the container through the environment, on a line of their own.
      'run' {
        if ($env:FAKE_DOCKER_LOG) {
          $seen = foreach ($k in 'KEEL_BACKUP_PASSPHRASE', 'KEEL_SECRET', 'KEEL_BACKUP_S3_BUCKET', 'KEEL_BACKUP_S3_SECRET_ACCESS_KEY', 'KEEL_RESTORE_NAME') {
            "$k=$([Environment]::GetEnvironmentVariable($k))"
          }
          Add-Content -LiteralPath $env:FAKE_DOCKER_LOG -Value ('env ' + ($seen -join ' '))
        }
        if ($env:FAKE_RESTORE_FAIL -and $a -contains '--verify-only') { [Console]::Error.WriteLine('Wrong passphrase'); exit 1 }
        if ($a -contains '--list') { 'keel-20261003-030000.tar.age' }
        exit 0
      }
      default { [Console]::Error.WriteLine("fake docker: unexpected compose call: $a"); exit 1 }
    }
  }
  { $_ -in 'pull', 'tag', 'ps' } { exit 0 }
  'inspect' { 'healthy'; exit 0 }
  'image' { '{"org.opencontainers.image.version":"0.0.1-test"}'; exit 0 }
  'volume' { exit 1 }
  'run' {
    if ($a -contains 'generate-env') {
      'POSTGRES_PASSWORD=0123456789abcdef0123456789abcdef0123456789abcdef'
      'KEEL_SERVICE_PASSWORD=fedcba9876543210fedcba9876543210fedcba9876543210'
      'KEEL_SECRET=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
      'KEEL_FUNCTIONS_TOKEN=ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'
      'KEEL_DASHBOARD_PASSWORD=FakePassword12345678'
      'IMGPROXY_KEY=aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00aa00'
      'IMGPROXY_SALT=bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11'
      exit 0
    }
    [Console]::Error.WriteLine("fake docker: unexpected run: $a"); exit 1
  }
  default { [Console]::Error.WriteLine("fake docker: unexpected call: $a"); exit 1 }
}
