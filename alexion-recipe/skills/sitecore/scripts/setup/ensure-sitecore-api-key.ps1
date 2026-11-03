<#
.INJECTED_VARIABLES
  $apiKeyId           [string] - Optional braced GUID of the target API Key item. Empty string = generate a new GUID.
  $name               [string] - Item name (e.g. "JSS API Key").
  $corsOrigins        [string] - Value for the "CORS Origins" field (default "*").
  $allowedControllers [string] - Value for the "AllowedControllers" field (default "*").
  $impersonationUser  [string] - Value for the "Impersonation User" field (default "extranet\Anonymous").

  Returns a single PSCustomObject with:
    status    : "created" | "updated" | "unchanged" | "failed"
    apiKey    : { id, name, path, fields { CORSOrigins, AllowedControllers, ImpersonationUser } }
    error     : string (only on status="failed")

  Field-name notes (Sitecore XP 10.4):
    - "AllowedControllers" has NO space (the version with a space silently
      no-ops). Verified against /sitecore/templates/System/Services/API Key.
    - "CORS Origins" and "Impersonation User" both have spaces.
    - Impersonation user MUST be "extranet\Anonymous" (per Sitecore docs);
      "sitecore\Anonymous" / "sitecore\admin" are wrong / unsafe.

  Run via: run-powershell-script (source-sitecore). Relocated from the former
  ensure-sitecore-api-key MCP tool (single source of truth; see references/setup/api-key.md).
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/"

    $apiKeysFolderPath = "/sitecore/system/Settings/Services/API Keys"
    $templatePath      = "/sitecore/templates/System/Services/API Key"

    # Verify the API Key template exists on this instance (template IDs vary
    # across Sitecore versions, so look up by path rather than hardcoding).
    $template = Get-Item -Path "master:$templatePath" -ErrorAction SilentlyContinue
    if (-not $template) {
        [PSCustomObject]@{
            status = "failed"
            error  = "API Key template not found at $templatePath. Sitecore install may be too old or the template was deleted."
        }
        return
    }

    # Ensure the parent /API Keys folder exists. Stock Sitecore ships it; if
    # missing the install is broken in a way this tool shouldn't try to fix.
    $parent = Get-Item -Path "master:$apiKeysFolderPath" -ErrorAction SilentlyContinue
    if (-not $parent) {
        [PSCustomObject]@{
            status = "failed"
            error  = "API Keys folder not found at $apiKeysFolderPath. Cannot create API Key item."
        }
        return
    }

    # Resolve the target ID. If caller didn't supply one, mint a fresh GUID
    # and bake it into the new item via -ForceId so the connector's
    # x-graphql-api-key value can match it deterministically.
    $targetId = $null
    $generatedId = $false
    if ([string]::IsNullOrWhiteSpace($apiKeyId)) {
        $targetId = "{$([System.Guid]::NewGuid().ToString().ToUpper())}"
        $generatedId = $true
    } else {
        # Normalize to braced uppercase. Sitecore.Data.ID.TryParse accepts
        # any of: braced, unbraced, dashed, undashed.
        $parsed = [Sitecore.Data.ID]::new([System.Guid]::Empty)
        if (-not [Sitecore.Data.ID]::TryParse($apiKeyId, [ref]$parsed)) {
            [PSCustomObject]@{
                status = "failed"
                error  = "apiKeyId is not a valid GUID: $apiKeyId"
            }
            return
        }
        $targetId = $parsed.ToString()
    }

    # Default field values (match Sitecore Headless Development docs).
    if ([string]::IsNullOrEmpty($corsOrigins))        { $corsOrigins = "*" }
    if ([string]::IsNullOrEmpty($allowedControllers)) { $allowedControllers = "*" }
    if ([string]::IsNullOrEmpty($impersonationUser))  { $impersonationUser = "extranet\Anonymous" }
    if ([string]::IsNullOrEmpty($name))               { $name = "JSS API Key" }

    # Bypass the SPE provider/cache and ask the database directly for the item
    # at $targetId. This is the most reliable way to detect "does an item with
    # this exact ID exist?" — the SPE provider is path-scoped and Get-Item -ID
    # doesn't work across all SPE versions.
    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")
    $existing = $db.GetItem([Sitecore.Data.ID]::Parse($targetId))

    $status = $null
    $created = $null
    if (-not $existing) {
        # New-Item -ForceId so the GUID matches the connector header value
        # (the orchestrator either supplied apiKeyId, or generated one and
        # will write it back to the connector).
        $created = New-Item `
            -Path "master:$apiKeysFolderPath" `
            -Name $name `
            -ItemType $templatePath `
            -ForceId $targetId
        $status = "created"
        $existing = $db.GetItem([Sitecore.Data.ID]::Parse($targetId))
        if (-not $existing) {
            [PSCustomObject]@{
                status = "failed"
                error  = "Created item but database.GetItem($targetId) returned null on round-trip verification."
            }
            return
        }
    }

    # Snapshot current field values so we can decide created/updated/unchanged.
    $existing.Fields.ReadAll()
    $beforeCors    = [string]$existing["CORS Origins"]
    $beforeAllowed = [string]$existing["AllowedControllers"]
    $beforeImpers  = [string]$existing["Impersonation User"]

    $needsWrite = $false
    if ($beforeCors -ne $corsOrigins)            { $needsWrite = $true }
    if ($beforeAllowed -ne $allowedControllers)  { $needsWrite = $true }
    if ($beforeImpers -ne $impersonationUser)    { $needsWrite = $true }

    if ($needsWrite) {
        $existing.Editing.BeginEdit() | Out-Null
        try {
            $existing["CORS Origins"]        = $corsOrigins
            $existing["AllowedControllers"]  = $allowedControllers
            $existing["Impersonation User"]  = $impersonationUser
            $existing.Editing.EndEdit() | Out-Null
        } catch {
            $existing.Editing.CancelEdit() | Out-Null
            throw
        }
        if ($status -ne "created") { $status = "updated" }
    } else {
        if ($status -ne "created") { $status = "unchanged" }
    }

    # Re-read from the database to verify the writes actually landed (and to
    # surface any field-name typo as a "field still empty" failure).
    $verified = $db.GetItem([Sitecore.Data.ID]::Parse($targetId))
    $verified.Fields.ReadAll()

    [PSCustomObject]@{
        status   = $status
        apiKey   = [ordered]@{
            id          = $verified.ID.ToString()
            name        = $verified.Name
            path        = $verified.Paths.FullPath
            generatedId = $generatedId
            fields      = [ordered]@{
                CORSOrigins        = [string]$verified["CORS Origins"]
                AllowedControllers = [string]$verified["AllowedControllers"]
                ImpersonationUser  = [string]$verified["Impersonation User"]
            }
        }
    }
} catch {
    [PSCustomObject]@{
        status = "failed"
        error  = $_.Exception.Message
    }
}
