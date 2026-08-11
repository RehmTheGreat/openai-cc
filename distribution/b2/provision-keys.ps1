[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9A-Za-z]+$')]
  [string]$BucketId,
  [string]$OutputPath,
  [switch]$ResetExisting
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$AuthorizeUrl = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account"
$PublisherKeyName = "openai-cc-publisher"
$IssuerKeyName = "openai-cc-issuer"
$PublisherPrefix = "releases/"
$OneYearSeconds = 31536000

function Invoke-B2JsonPost {
  param(
    [Parameter(Mandatory = $true)][string]$ApiUrl,
    [Parameter(Mandatory = $true)][string]$AuthorizationToken,
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][hashtable]$Body
  )

  return Invoke-RestMethod `
    -Method Post `
    -Uri "$($ApiUrl.TrimEnd('/'))/b2api/v4/$Operation" `
    -Headers @{ Authorization = $AuthorizationToken } `
    -ContentType "application/json" `
    -Body ($Body | ConvertTo-Json -Depth 8 -Compress) `
    -TimeoutSec 60
}

function Get-AllApplicationKeys {
  param(
    [Parameter(Mandatory = $true)][string]$ApiUrl,
    [Parameter(Mandatory = $true)][string]$AuthorizationToken,
    [Parameter(Mandatory = $true)][string]$AccountId
  )

  $keys = @()
  $nextId = $null
  do {
    $body = @{ accountId = $AccountId; maxKeyCount = 1000 }
    if ($nextId) { $body.startApplicationKeyId = $nextId }
    $page = Invoke-B2JsonPost -ApiUrl $ApiUrl -AuthorizationToken $AuthorizationToken -Operation "b2_list_keys" -Body $body
    $keys += @($page.keys)
    $nextId = [string]$page.nextApplicationKeyId
  } while ($nextId)
  return @($keys)
}

function Write-PrivateJson {
  param(
    [Parameter(Mandatory = $true)][string]$PathValue,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $full = [IO.Path]::GetFullPath($PathValue)
  $parent = Split-Path $full -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $encoding = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($full, (($Value | ConvertTo-Json -Depth 8) + "`n"), $encoding)

  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "Allow")
    [void]$acl.AddAccessRule($rule)
    Set-Acl -Path $full -AclObject $acl
  } catch {
    Write-Warning "Could not tighten the output-file ACL automatically. Keep the file private and delete it after moving the secrets to a password manager/GitHub Secrets."
  }

  return $full
}

Write-Host "OpenAI-CC Backblaze B2 distribution key provisioning" -ForegroundColor Cyan
Write-Host "This helper uses the master key only in this process. It never writes the master secret to disk." -ForegroundColor DarkGray
Write-Host "Bucket ID: $BucketId"

$masterKeyId = Read-Host "Master Application Key ID"
$masterSecure = Read-Host "Master Application Key SECRET" -AsSecureString
$masterKey = $null
$basic = $null
$auth = $null

try {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($masterSecure)
  try {
    $masterKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }

  if (-not $masterKeyId -or -not $masterKey) { throw "Master key ID and secret are required." }
  $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$masterKeyId`:$masterKey"))
  $auth = Invoke-RestMethod -Method Get -Uri $AuthorizeUrl -Headers @{ Authorization = "Basic $basic" } -TimeoutSec 60

  $storage = $auth.apiInfo.storageApi
  if (-not $auth.authorizationToken -or -not $auth.accountId -or -not $storage.apiUrl -or -not $storage.allowed) {
    throw "Backblaze authorization response is incomplete."
  }

  $capabilities = @($storage.allowed.capabilities)
  foreach ($required in @("listKeys", "writeKeys", "deleteKeys")) {
    if ($capabilities -notcontains $required) {
      throw "The supplied master credential is missing required capability '$required'. Use the Master Application Key, not a normal bucket key."
    }
  }

  $apiUrl = [string]$storage.apiUrl
  $token = [string]$auth.authorizationToken
  $accountId = [string]$auth.accountId

  $existing = @(Get-AllApplicationKeys -ApiUrl $apiUrl -AuthorizationToken $token -AccountId $accountId |
    Where-Object { $_.keyName -in @($PublisherKeyName, $IssuerKeyName) -and [string]$_.applicationKeyId -ne $masterKeyId })

  if ($existing.Count -gt 0 -and -not $ResetExisting) {
    $summary = ($existing | ForEach-Object { "$($_.keyName) [$($_.applicationKeyId)]" }) -join ", "
    throw "Existing OpenAI-CC distribution key(s) already exist: $summary. This commonly happens after repeated setup attempts. Rerun this helper with -ResetExisting to revoke those matching keys and create one clean publisher + issuer pair."
  }

  if ($ResetExisting) {
    foreach ($item in $existing) {
      Write-Host "Revoking old $($item.keyName) [$($item.applicationKeyId)]" -ForegroundColor Yellow
      Invoke-B2JsonPost -ApiUrl $apiUrl -AuthorizationToken $token -Operation "b2_delete_key" -Body @{
        applicationKeyId = [string]$item.applicationKeyId
      } | Out-Null
    }
  }

  $publisher = Invoke-B2JsonPost -ApiUrl $apiUrl -AuthorizationToken $token -Operation "b2_create_key" -Body @{
    accountId = $accountId
    capabilities = @("writeFiles")
    keyName = $PublisherKeyName
    validDurationInSeconds = $OneYearSeconds
    bucketIds = @($BucketId)
    namePrefix = $PublisherPrefix
  }

  if (-not $publisher.applicationKeyId -or -not $publisher.applicationKey) {
    throw "Backblaze did not return a complete publisher key."
  }

  try {
    $issuer = Invoke-B2JsonPost -ApiUrl $apiUrl -AuthorizationToken $token -Operation "b2_create_key" -Body @{
      accountId = $accountId
      capabilities = @("writeKeys", "deleteKeys")
      keyName = $IssuerKeyName
      validDurationInSeconds = $OneYearSeconds
    }
  } catch {
    try {
      Invoke-B2JsonPost -ApiUrl $apiUrl -AuthorizationToken $token -Operation "b2_delete_key" -Body @{
        applicationKeyId = [string]$publisher.applicationKeyId
      } | Out-Null
    } catch { }
    throw
  }

  if (-not $issuer.applicationKeyId -or -not $issuer.applicationKey) {
    try {
      Invoke-B2JsonPost -ApiUrl $apiUrl -AuthorizationToken $token -Operation "b2_delete_key" -Body @{
        applicationKeyId = [string]$publisher.applicationKeyId
      } | Out-Null
    } catch { }
    throw "Backblaze did not return a complete issuer key. The newly created publisher was revoked to avoid a half-configured state."
  }

  if (-not $OutputPath) {
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
    $OutputPath = Join-Path $env:TEMP "openai-cc-b2-credentials-$stamp.json"
  }

  $result = [ordered]@{
    schemaVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString("o")
    bucketId = $BucketId
    publisher = [ordered]@{
      keyName = $PublisherKeyName
      applicationKeyId = [string]$publisher.applicationKeyId
      applicationKey = [string]$publisher.applicationKey
      capabilities = @("writeFiles")
      namePrefix = $PublisherPrefix
      githubSecretIdName = "B2_PUBLISH_KEY_ID"
      githubSecretKeyName = "B2_PUBLISH_KEY"
      githubVariableBucketName = "B2_BUCKET_ID"
    }
    issuer = [ordered]@{
      keyName = $IssuerKeyName
      applicationKeyId = [string]$issuer.applicationKeyId
      applicationKey = [string]$issuer.applicationKey
      capabilities = @("writeKeys", "deleteKeys")
      storage = "trusted administrator PC/password manager only"
    }
  }

  $written = Write-PrivateJson -PathValue $OutputPath -Value $result

  Write-Host "" 
  Write-Host "Created exactly one clean publisher + issuer pair." -ForegroundColor Green
  Write-Host "Publisher key ID: $($publisher.applicationKeyId)"
  Write-Host "Issuer key ID:    $($issuer.applicationKeyId)"
  Write-Host "Secrets were NOT printed." -ForegroundColor Green
  Write-Host "Private credential file: $written" -ForegroundColor Yellow
  Write-Host "" 
  Write-Host "GitHub Actions gets ONLY publisher.applicationKeyId -> B2_PUBLISH_KEY_ID, publisher.applicationKey -> B2_PUBLISH_KEY, and bucketId -> B2_BUCKET_ID." -ForegroundColor Cyan
  Write-Host "Keep issuer.* only on your trusted admin PC/password manager. Never put the master key or issuer key in GitHub." -ForegroundColor Cyan
  Write-Host "After copying the two publisher values into GitHub Secrets and saving issuer.* safely, delete the temporary JSON file." -ForegroundColor Yellow
} finally {
  $masterKey = $null
  $masterSecure = $null
  $basic = $null
  $auth = $null
}
