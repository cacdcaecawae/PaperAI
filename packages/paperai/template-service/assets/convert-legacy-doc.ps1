param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'

# Word is launched by DCOM, outside PowerShell's process tree. The job owns only this automation instance.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class PaperAIWordLifetime : IDisposable {
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  private SafeFileHandle job;
  private Process process;

  public PaperAIWordLifetime(int windowHandle) {
    uint processId;
    if (GetWindowThreadProcessId(new IntPtr(windowHandle), out processId) == 0 || processId == 0)
      throw new Win32Exception(Marshal.GetLastWin32Error());
    process = Process.GetProcessById((int)processId);
    try {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(job, process.Handle))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    } catch {
      try { if (!process.HasExited) process.Kill(); }
      finally { Dispose(); }
      throw;
    }
  }

  public void Dispose() {
    if (job != null) { job.Dispose(); job = null; }
    if (process != null) { process.WaitForExit(); process.Dispose(); process = null; }
  }
}
"@

$word = $null
$document = $null
$lifetime = $null
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
  # Word exposes Hwnd on a document window, so bind ownership before opening the supplied file.
  $bootstrap = $word.Documents.Add()
  $lifetime = [PaperAIWordLifetime]::new($bootstrap.ActiveWindow.Hwnd)
  $bootstrap.Close($false)
  $password = [Guid]::NewGuid().ToString('N').Substring(0, 15)
  $missing = [Type]::Missing
  $document = $word.Documents.Open($SourcePath, $false, $true, $false, $password, $missing, $missing, $password)
  $document.SaveAs2($OutputPath, 16)
}
finally {
  try {
    try {
      if ($null -ne $document) {
        $document.Close($false)
      }
    }
    finally {
      if ($null -ne $word) {
        $word.Quit([ref]0)
      }
    }
  }
  finally {
    if ($null -ne $lifetime) { $lifetime.Dispose() }
  }
}
