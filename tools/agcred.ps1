# EasyAG helper: read/write the Antigravity system credential in Windows Credential Manager.
# AG >= 2.0 keeps its IDE login in a generic credential named "gemini:antigravity".
# Usage:
#   agcred.ps1 -Mode read            -> prints base64 of the stored secret (empty if absent)
#   agcred.ps1 -Mode write < b64file -> reads base64 from stdin and writes the credential
param(
  [Parameter(Mandatory = $true)][ValidateSet('read', 'write')][string]$Mode
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class AgCred {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CredentialW credential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CredentialW {
    public uint flags;
    public uint type;
    public string targetName;
    public string comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME lastWritten;
    public uint blobSize;
    public IntPtr blob;
    public uint persist;
    public uint attributeCount;
    public IntPtr attributes;
    public string targetAlias;
    public string userName;
  }
}
'@

$target = 'gemini:antigravity'
$user = 'antigravity'
$CRED_TYPE_GENERIC = 1
$CRED_PERSIST_LOCAL_MACHINE = 2
$ERROR_NOT_FOUND = 1168

function Get-Win32Message($code) {
  $ex = New-Object ComponentModel.Win32Exception($code)
  return ('{0} ({1})' -f $ex.Message, $code)
}

if ($Mode -eq 'write') {
  $b64 = [Console]::In.ReadToEnd().Trim()
  if ([string]::IsNullOrEmpty($b64)) { throw 'empty stdin' }
  $bytes = [Convert]::FromBase64String($b64)
  $cred = New-Object AgCred+CredentialW
  $cred.flags = 0
  $cred.type = $CRED_TYPE_GENERIC
  $cred.targetName = $target
  $cred.comment = $null
  $cred.lastWritten = New-Object System.Runtime.InteropServices.ComTypes.FILETIME
  $cred.blobSize = [uint32]$bytes.Length
  $cred.blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $cred.blob, $bytes.Length)
  $cred.persist = $CRED_PERSIST_LOCAL_MACHINE
  $cred.attributeCount = 0
  $cred.attributes = [IntPtr]::Zero
  $cred.targetAlias = $null
  $cred.userName = $user
  try {
    if (-not [AgCred]::CredWriteW([ref]$cred, 0)) {
      throw ('CredWriteW failed: ' + (Get-Win32Message ([Runtime.InteropServices.Marshal]::GetLastWin32Error())))
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.blob)
  }
  exit 0
}

$ptr = [IntPtr]::Zero
if (-not [AgCred]::CredReadW($target, $CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -eq $ERROR_NOT_FOUND) { exit 0 }
  throw ('CredReadW failed: ' + (Get-Win32Message $code))
}
try {
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][AgCred+CredentialW])
  if ($cred.blobSize -gt 0 -and $cred.blob -ne [IntPtr]::Zero) {
    $bytes = New-Object byte[] $cred.blobSize
    [Runtime.InteropServices.Marshal]::Copy($cred.blob, $bytes, 0, [int]$cred.blobSize)
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
  }
} finally {
  [AgCred]::CredFree($ptr)
}
