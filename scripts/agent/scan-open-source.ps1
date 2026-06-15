[CmdletBinding()]
param(
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$rg = Get-Command rg -ErrorAction SilentlyContinue

$excludeGlobs = @(
  '!logs/**',
  '!tmp/**',
  '!artifacts/**',
  '!docs/plans/**',
  '!bin/**',
  '!node_modules/**',
  '!**/node_modules/**',
  '!**/.hvigor/**',
  '!**/build/**',
  '!**/entry/build/**',
  '!tools/harmony/diagnostics/**',
  '!tools/harmony/local-hvigor/**',
  '!tools/harmony/sdk-overlay/**',
  '!tools/harmony/sdk-shim-cli/**',
  '!*.local.psd1',
  '!scripts/agent/scan-open-source.ps1',
  '!HarmonyCodexRemote/entry/src/main/ets/config/BridgeConfig.ets',
  '!HarmonyHdcRelayHelper/entry/src/main/ets/config/BridgeConfig.ets',
  '!HarmonyHdcRelayHelper/entry/src/main/ets/config/RelayConfig.ets',
  '!HarmonyCodexRelay/**',
  '!*.hap',
  '!*.p12',
  '!*.p7b',
  '!*.cer'
)

$patterns = @(
  @{ id = 'local-user-path'; pattern = 'C:\\Users\\[^\\]+'; severity = 'high' },
  @{ id = 'escaped-local-user-path'; pattern = 'C:\\\\Users\\\\[^\\]+'; severity = 'high' },
  @{ id = 'ohos-local-signing-path'; pattern = '\\.ohos\\config'; severity = 'high' },
  @{ id = 'harmony-key-password'; pattern = '"keyPassword"\s*:\s*"[A-Za-z0-9]{12,}"'; severity = 'high' },
  @{ id = 'harmony-store-password'; pattern = '"storePassword"\s*:\s*"[A-Za-z0-9]{12,}"'; severity = 'high' },
  @{ id = 'bridge-token-like-value'; pattern = 'codex-mobile-bridge-[0-9]{8,}'; severity = 'high' },
  @{ id = 'relay-secret-like-value'; pattern = 'DEFAULT_RELAY_TOKEN:\s*string\s*=\s*''[^<][^'']{12,}'''; severity = 'high' },
  @{ id = 'hardcoded-root-ssh-host'; pattern = 'root@[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'; severity = 'high' },
  @{ id = 'public-relay-url-like-value'; pattern = 'https?://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+'; severity = 'high' },
  @{ id = 'rdp-saved-username'; pattern = 'username:s:[^<\r\n]+'; severity = 'high' },
  @{ id = 'rdp-saved-address'; pattern = 'full address:s:[^<\r\n]+'; severity = 'medium' },
  @{ id = 'windowsapps-codex-path'; pattern = 'Program Files\\WindowsApps\\OpenAI\.Codex'; severity = 'medium' },
  @{ id = 'private-download-path'; pattern = 'QMDownload|Tencent Files'; severity = 'medium' },
  @{ id = 'private-relay-alias'; pattern = '\byoupeng\b'; severity = 'medium' }
)

$findings = @()

$previousLocation = Get-Location
try {
  Set-Location -LiteralPath $repoRoot
  if ($rg) {
    foreach ($item in $patterns) {
      $args = @('--line-number', '--hidden', '--no-heading')
      foreach ($glob in $excludeGlobs) {
        $args += '--glob'
        $args += $glob
      }
      $args += '-e'
      $args += $item.pattern
      $args += '.'

      $output = & $rg.Source @args 2>$null
      foreach ($line in @($output)) {
        if ([string]::IsNullOrWhiteSpace($line)) {
          continue
        }
        if (($item.id -eq 'local-user-path' -or $item.id -eq 'escaped-local-user-path') -and
            ($line -match 'C:\\Users\\agent\\' -or $line -match 'C:\\\\Users\\\\agent\\\\')) {
          continue
        }
        if ($item.id -eq 'public-relay-url-like-value') {
          if ($line -match 'https?://(127\.|localhost|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)') {
            continue
          }
        }
        $script:findings += [pscustomobject]@{
          id = $item.id
          severity = $item.severity
          match = $line
        }
      }
    }
  } else {
    $script:findings += [pscustomobject]@{
      id = 'ripgrep-missing'
      severity = 'medium'
      match = 'rg is not installed; open-source scan was not performed'
    }
  }
} finally {
  Set-Location -LiteralPath $previousLocation
}

foreach ($forbiddenName in @('bootstrap.js', 'preload.js')) {
  $forbiddenFiles = @(Get-ChildItem -LiteralPath $repoRoot -Recurse -Force -File -Filter $forbiddenName -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\.git\\' })
  foreach ($file in $forbiddenFiles) {
    $script:findings += [pscustomobject]@{
      id = 'extracted-desktop-entrypoint-file'
      severity = 'medium'
      match = $file.FullName.Substring($repoRoot.Length).TrimStart('\', '/')
    }
  }
}

$high = @($findings | Where-Object { $_.severity -eq 'high' })
$summary = [pscustomobject]@{
  ok = $high.Count -eq 0
  generatedAt = (Get-Date).ToString('o')
  repoRoot = $repoRoot
  findingCount = $findings.Count
  highRiskCount = $high.Count
  findings = @($findings)
}

if ($Json) {
  $summary | ConvertTo-Json -Depth 8
} else {
  if ($summary.ok) {
    Write-Host "Open-source scan passed." -ForegroundColor Green
  } else {
    Write-Host "Open-source scan found high-risk findings." -ForegroundColor Red
  }
  $findings | Format-Table -AutoSize
  if (-not $summary.ok) {
    exit 1
  }
}
