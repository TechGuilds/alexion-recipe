<#
.INJECTED_VARIABLES
  (none)

  Returns a single PSCustomObject with:
    status     : "ok" | "failed"
    count      : int                    (number of renderings returned)
    fetchedAt  : ISO-8601 string        (UTC, set by the script)
    renderings : [ { name, id, path, template_name,
                     controller_class, controller_action, view_path,
                     component_name, model, datasource_template,
                     datasource_location, parameters_template } ]
    error      : string                  (only on status="failed")

  Read-only. Enumerates EVERY rendering item under
  /sitecore/layout/Renderings whose template name matches one of the
  rendering-like templates Sitecore uses (MVC + Headless). No
  site-specific filter — the projection is structural ("what renderings
  exist and what code do they point at?"), not site-scoped ("which ones
  does this site use?").

  Active-vs-unused filtering belongs to a different artifact
  (rendering-usage.jsonl) derived from layout fields on actual content
  items.

  The projected fields cover both migration paths:

    MVC (xpmvc2sai)        — controller_class, controller_action, view_path, model
    Headless (xpheadless2sai) — component_name (Json Rendering -> React)
    Universal              — datasource_template, datasource_location,
                             parameters_template (datasource + rendering-params
                             discovery, regardless of rendering type)

  Per-rendering fields are nullable; populate only what's set on the
  Sitecore item. Returning more than this would inflate LLM context;
  returning less would force a second round-trip.
#>
$ErrorActionPreference = "Stop"

try {
    Set-Location "master:/"

    $renderingsRoot = Get-Item -Path "master:/sitecore/layout/Renderings" -ErrorAction Stop

    # Cast wide on template names so consumers other than MVC Code
    # Analysis (e.g. JSS-side or future agents) get the same artifact.
    $renderingTemplates = @(
        "Controller Rendering",
        "View Rendering",
        "Json Rendering",
        "MVC Layout",
        "Sublayout"
    )

    $matched = $renderingsRoot.Axes.GetDescendants() |
        Where-Object { $renderingTemplates -contains $_.TemplateName }

    $projected = foreach ($r in $matched) {
        $controllerClass    = [string]$r["Controller"]
        $controllerAction   = [string]$r["Controller Action"]
        $viewPath           = [string]$r["Path"]
        $componentName      = [string]$r["componentName"]
        $model              = [string]$r["Model"]
        $datasourceTemplate = [string]$r["Datasource Template"]
        $datasourceLocation = [string]$r["Datasource Location"]
        $parametersTemplate = [string]$r["Parameters Template"]

        [PSCustomObject]@{
            name                = $r.Name
            id                  = $r.ID.ToString()
            path                = $r.Paths.FullPath
            template_name       = $r.TemplateName
            controller_class    = if ([string]::IsNullOrWhiteSpace($controllerClass))    { $null } else { $controllerClass }
            controller_action   = if ([string]::IsNullOrWhiteSpace($controllerAction))   { $null } else { $controllerAction }
            view_path           = if ([string]::IsNullOrWhiteSpace($viewPath))           { $null } else { $viewPath }
            component_name      = if ([string]::IsNullOrWhiteSpace($componentName))      { $null } else { $componentName }
            model               = if ([string]::IsNullOrWhiteSpace($model))              { $null } else { $model }
            datasource_template = if ([string]::IsNullOrWhiteSpace($datasourceTemplate)) { $null } else { $datasourceTemplate }
            datasource_location = if ([string]::IsNullOrWhiteSpace($datasourceLocation)) { $null } else { $datasourceLocation }
            parameters_template = if ([string]::IsNullOrWhiteSpace($parametersTemplate)) { $null } else { $parametersTemplate }
        }
    }

    # Force-array (avoid PowerShell's one-element-collapses-to-scalar
    # quirk that breaks JSON consumers expecting renderings: []).
    $arr = @($projected)

    [PSCustomObject]@{
        status     = "ok"
        count      = $arr.Count
        fetchedAt  = [DateTime]::UtcNow.ToString("o")
        renderings = $arr
    }
} catch {
    [PSCustomObject]@{
        status = "failed"
        error  = $_.Exception.Message
    }
}
