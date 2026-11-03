# Exact ItemPaths[] and Devices[] IDs required. Shared/final resolved occurrences
# preserve repeats and order; XML preserves deltas. Does not flatten SXA designs.
if (-not $Devices) { throw 'Devices must explicitly list Sitecore device IDs' }
Start-KajooExport 'presentation'
Write-KajooRecord 'presentation.jsonl' $null
Read-KajooItems $ItemPaths | ForEach-Object {
    $item = $_
    foreach ($deviceId in $Devices) {
        try {
            $requestedId = ([guid]$deviceId).ToString('D')
            $devicesForDatabase = [Sitecore.Configuration.Factory]::GetDatabase($Database).Resources.Devices.GetAll()
            $matches = @($devicesForDatabase | Where-Object { ([string]$_.ID).Trim('{}') -ieq $requestedId })
            if ($matches.Count -ne 1) { throw 'Device not found or ambiguous' }
            $device = $matches[0]
            $record = Get-KajooIdentity $item
            $record.deviceId = [string]$deviceId
            $record.sharedXml = Get-KajooField $item '__Renderings'
            $record.finalXml = Get-KajooField $item '__Final Renderings'
            $record.shared = @(Get-KajooOccurrences $item $device)
            $record.final = @(Get-KajooOccurrences $item $device -Final)
            $record.sxa = [ordered]@{pageDesign=(Get-KajooField $item 'Page Design'); partialDesigns=(Get-KajooField $item 'PartialDesigns'); basePartialDesign=(Get-KajooField $item 'Base Partial Design'); expanded=$false}
            # Design references are findings for dependency analysis, not failed reads.
            # Keep expanded=false; the assembler reports their separate completeness.
            $record.inheritance = 'SPE resolved occurrences; original shared/final field XML retained. SXA design expansion requires separate inspection.'
            Write-KajooRecord 'presentation.jsonl' $record
        } catch { Add-KajooError ([string]$item.ID + ':' + $deviceId) 'Presentation/device resolution failed' }
    }
}
Complete-KajooExport @{itemPaths=@($ItemPaths); devices=@($Devices); database=$Database; languages=@($Languages); version=$Version; sxaDesignExpansion=$false}
