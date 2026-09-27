param([string]$LockedPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$window = [System.Windows.Forms.Form]::new()
$file = [System.IO.File]::Open($LockedPath, 'OpenOrCreate', 'ReadWrite', 'None')
try {
  [Console]::WriteLine($window.Handle.ToInt64())
  while ($true) { Start-Sleep -Milliseconds 100 }
}
finally {
  $file.Dispose()
  $window.Dispose()
}
