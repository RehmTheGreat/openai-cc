[CmdletBinding()]
param(
  [string]$CredentialFile,
  [string]$BucketId
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$AuthorizeUrl = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"
$ExpectedPrefix = "releases/"

function ConvertFrom-SecureStringPlain([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$keyId = $null
$key = $null

try {
  if ($CredentialFile) {
    $full = [IO.Path]::GetFullPath($CredentialFile)
    if (-not (Test-Path $full -PathType Leaf)) { throw "Credential file does not exist: $full" }
    $json = Get-Content $full -Raw | ConvertFrom-Json
    $keyId = [string]$json.publisher.applicationKeyId
    $key = [string]$json.publisher.applicationKey
    if (-not $BucketId) { $BucketId = [string]$json.bucketId }
  } else {
    $keyId = Read-Host "Publisher Application Key ID"
    $secure = Read-Host "Publisher Application Key SECRET" -AsSecureString
    $key = ConvertFrom-SecureStringPlain $secure
    if (-not $BucketId) { $BucketId = Read-Host "Distribution Bucket ID" }
  }

  $keyId = [string]$keyId
  $key = [string]$key
  $BucketId = [string]$BucketId
  if (-not $keyId -or -not $key -or -not $BucketId) { throw "Publisher key ID, publisher secret, and bucket ID are required." }

  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$keyId`:$key"))
  try {
    $auth = Invoke-RestMethod -Method Get -Uri $AuthorizeUrl -Headers @{ Authorization = "Basic $basic" } -TimeoutSec 60
  } catch {
    $detail = $_.ErrorDetails.Message
    if ($detail -match 'bad_auth_token') {
      throw "Backblaze rejected this publisher credential pair (bad_auth_token). The ID and secret are mismatched, copied with extra characters/quotes, expired, or the key was deleted. Do not put this pair into GitHub."
    }
    throw
  }

  $storage = $auth.apiInfo.storageApi
  if (-not $auth.authorizationToken -or -not $storage.allowed) { throw "Backblaze authorization response is incomplete." }

  $actualCaps = @($storage.allowed.capabilities | Sort-Object)
  if ($actualCaps.Count -ne 1 -or $actualCaps[0] -ne "writeFiles") {
    throw "Publisher capability mismatch. Expected exactly writeFiles; got: $($actualCaps -join ', ')."
  }

  $buckets = @($storage.allowed.buckets)
  if ($buckets.Count -ne 1 -or [string]$buckets[0].id -ne $BucketId) {
    $actual = if ($buckets.Count -eq 1) { [string]$buckets[0].id } else { "count=$($buckets.Count)" }
    throw "Publisher bucket scope mismatch. Expected exactly $BucketId; got $actual."
  }

  if ([string]$storage.allowed.namePrefix -ne $ExpectedPrefix) {
    throw "Publisher prefix mismatch. Expected '$ExpectedPrefix'; got '$([string]$storage.allowed.namePrefix)'."
  }

  Write-Host "[OK] Publisher credential is valid against live Backblaze." -ForegroundColor Green
  Write-Host "Key ID:       $keyId"
  Write-Host "Bucket ID:    $BucketId"
  Write-Host "Capability:   writeFiles"
  Write-Host "Prefix:       $ExpectedPrefix"
  Write-Host "Secret was not printed." -ForegroundColor Green
} finally {
  $key = $null
  $basic = $null
  $auth = $null
}
