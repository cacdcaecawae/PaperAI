param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$word = $null
$document = $null

try {
  try {
    $word = New-Object -ComObject Word.Application
  }
  catch {
    [Console]::Error.WriteLine("PAPERAI_WORD_COM_UNAVAILABLE: $($_.Exception.Message)")
    exit 42
  }

  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $document = $word.Documents.Open($SourcePath, $false, $true, $false)
  $document.SaveAs2($OutputPath, 16)
}
finally {
  if ($null -ne $document) {
    $document.Close($false)
    [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) | Out-Null
  }
  if ($null -ne $word) {
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null
  }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
