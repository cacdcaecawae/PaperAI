param([string]$ConverterPath, [string]$WindowHandle, [string]$Root, [string]$Mode)

$ErrorActionPreference = 'Stop'
$document = [pscustomobject]@{}
$document | Add-Member ScriptMethod SaveAs2 { param($path, $format) }
$document | Add-Member ScriptMethod Close { throw 'document close failed' }
$documents = [pscustomobject]@{}
$documents | Add-Member ScriptMethod Add {
  $bootstrap = [pscustomobject]@{ ActiveWindow = [pscustomobject]@{ Hwnd = [int]$WindowHandle } }
  $bootstrap | Add-Member ScriptMethod Close { param($save) }
  return $bootstrap
}
$documents | Add-Member ScriptMethod Open {
  param($source, $confirm, $readOnly, $recent, $password, $templatePassword, $revert, $writePassword)
  if ($confirm -or !$readOnly -or $recent -or !$password -or !$writePassword) {
    throw 'unsafe document open arguments'
  }
  [System.IO.File]::WriteAllText((Join-Path $Root 'opened'), 'ready')
  if ($Mode -eq 'hang') { while ($true) { Start-Sleep -Milliseconds 100 } }
  return $document
}
$fakeWord = [pscustomobject]@{ Visible = $false; DisplayAlerts = 0; AutomationSecurity = 3; Documents = $documents }
$fakeWord | Add-Member ScriptMethod Quit { [System.IO.File]::WriteAllText((Join-Path $Root 'quit'), 'called') }
function New-Object { param($ComObject) return $fakeWord }
& $ConverterPath (Join-Path $Root 'source.doc') (Join-Path $Root 'target.docx')
