<#
.INJECTED_VARIABLES
  $apiKeyId [string] - Braced/unbraced GUID of the API Key item to fetch.

  Returns a single PSCustomObject with:
    status : "found" | "not-found" | "failed"
    apiKey : { id, name, path, fields { CORSOrigins, AllowedControllers, ImpersonationUser } }
    error  : string (only on status="failed")

  Read-only. Bypasses the SPE provider/cache by going through
  Sitecore.Configuration.Factory so a freshly-created item is visible
  immediately after `ensure-sitecore-api-key` runs.

  Field-name notes (Sitecore XP 10.4):
    - "AllowedControllers" has NO space.
    - "CORS Origins" and "Impersonation User" both have spaces.

  Run via: run-powershell-script (source-sitecore). Relocated from the former
  get-sitecore-api-key MCP tool (single source of truth; see references/setup/api-key.md).
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/"

    if ([string]::IsNullOrWhiteSpace($apiKeyId)) {
        [PSCustomObject]@{
            status = "failed"
            error  = "apiKeyId is required."
        }
        return
    }

    # Normalize whatever the caller passed (braced/unbraced, dashed/undashed).
    $parsed = [Sitecore.Data.ID]::new([System.Guid]::Empty)
    if (-not [Sitecore.Data.ID]::TryParse($apiKeyId, [ref]$parsed)) {
        [PSCustomObject]@{
            status = "failed"
            error  = "apiKeyId is not a valid GUID: $apiKeyId"
        }
        return
    }

    $db = [Sitecore.Configuration.Factory]::GetDatabase("master")
    $item = $db.GetItem($parsed)

    if (-not $item) {
        [PSCustomObject]@{
            status = "not-found"
            apiKey = [ordered]@{
                id = $parsed.ToString()
            }
        }
        return
    }

    $item.Fields.ReadAll()

    [PSCustomObject]@{
        status = "found"
        apiKey = [ordered]@{
            id     = $item.ID.ToString()
            name   = $item.Name
            path   = $item.Paths.FullPath
            fields = [ordered]@{
                CORSOrigins        = [string]$item["CORS Origins"]
                AllowedControllers = [string]$item["AllowedControllers"]
                ImpersonationUser  = [string]$item["Impersonation User"]
            }
        }
    }
} catch {
    [PSCustomObject]@{
        status = "failed"
        error  = $_.Exception.Message
    }
}
