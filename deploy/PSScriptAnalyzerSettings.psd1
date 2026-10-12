# PSScriptAnalyzer settings for the Windows installer and keel command (CI runs
# Invoke-ScriptAnalyzer -Path deploy -Recurse -Settings deploy/PSScriptAnalyzerSettings.psd1).
@{
  Severity     = @('Error', 'Warning')
  ExcludeRules = @(
    # Both scripts talk to a person at a console. Write-Host keeps those
    # messages out of functions' return values, which Write-Output would not.
    'PSAvoidUsingWriteHost',
    # install.ps1's parameters are read inside Install-Keel (script scope),
    # which this rule doesn't follow.
    'PSReviewUnusedParameter'
  )
}
