# Sets System.AppUserModel.ID on an existing .lnk shortcut.
#
# Why this exists
# ---------------
# Windows 10 / 11 silently drops toast notifications from desktop apps
# unless the Start-Menu shortcut that "represents" the app carries an
# AppUserModelID property. The plain WScript.Shell.CreateShortcut COM
# object that PowerShell exposes can't write into a shortcut's
# PropertyStore — so we drop one level deeper into IShellLink +
# IPropertyStore and set PKEY_AppUserModel_ID directly.
#
# Without this step, `new Notification(...)` from Electron's main
# process resolves `Notification.isSupported() === true` and runs
# without throwing, but the toast never appears. There is no error.
#
# Usage
# -----
#   powershell.exe -NoProfile -ExecutionPolicy Bypass `
#       -File set-aumid.ps1 `
#       -LinkPath "C:\path\to\My App.lnk" `
#       -Aumid "com.example.app"
#
# Exits 0 on success or no-op (target .lnk missing); exits non-zero
# only on hard COM/marshal failure. Callers should log stderr but
# treat any non-zero as best-effort failure, not fatal.

param(
  [Parameter(Mandatory = $true)][string]$LinkPath,
  [Parameter(Mandatory = $true)][string]$Aumid
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $LinkPath)) {
  Write-Host "[set-aumid] target shortcut does not exist: $LinkPath"
  exit 0
}

# Compile the COM interop types once per PowerShell host. Add-Type is
# idempotent within a process — re-running this script in the same
# host is fine, but our normal invocation is a fresh powershell.exe
# from execFile() so the compile happens every call.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace NexusLauncher {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Explicit, Size = 16)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr p;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
  }

  [ComImport, Guid("0000010b-0000-0000-c000-000000000046"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPersistFile {
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName,
             [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class CShellLink { }
}
"@

# Open the .lnk for read+write via IPersistFile.
$link = New-Object NexusLauncher.CShellLink
try {
  $pf = [NexusLauncher.IPersistFile] $link
  $pf.Load($LinkPath, 2)  # STGM_READWRITE

  # PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3} pid=5
  $ps = [NexusLauncher.IPropertyStore] $link
  $key = New-Object NexusLauncher.PROPERTYKEY
  $key.fmtid = [Guid] '9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3'
  $key.pid   = 5

  # VT_LPWSTR (31) — string allocated via CoTaskMem so the property
  # store can take ownership without copying. We free it after Commit
  # in case the store made its own copy (it usually does).
  $pv = New-Object NexusLauncher.PROPVARIANT
  $pv.vt = 31
  $pv.p  = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($Aumid)

  try {
    $ps.SetValue([ref] $key, [ref] $pv)
    $ps.Commit()
    $pf.Save($LinkPath, $true)
  } finally {
    [Runtime.InteropServices.Marshal]::FreeCoTaskMem($pv.p) | Out-Null
  }

  Write-Host "[set-aumid] OK: $LinkPath -> $Aumid"
} finally {
  [Runtime.InteropServices.Marshal]::ReleaseComObject($link) | Out-Null
}

exit 0
