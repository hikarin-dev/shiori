// remove.js — what the desktop app deletes a gallery's folder or archive with (Library's `remove`):
// on Windows, Windows' own file operation (IFileOperation), the one Explorer deletes with —
// permanently, never to the recycle bin, and with no dialog. Deleted that way, Explorer is told: a
// window showing the folder, or a folder inside it, steps back out of it on its own instead of
// finding it gone (which makes it complain, and can bring it down). Run in a short PowerShell; the
// plain delete takes whatever that leaves (it couldn't run, or couldn't delete it all), and is the
// only one off Windows.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

// FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI (FOF_NO_UI), and neither
// FOF_ALLOWUNDO nor FOFX_RECYCLEONDELETE, so the delete is permanent.
const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ShioriRemove {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {}
  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOperation {
    uint Advise(IntPtr sink); void Unadvise(uint cookie); void SetOperationFlags(uint flags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message); void SetProgressDialog(IntPtr dialog);
    void SetProperties(IntPtr properties); void SetOwnerWindow(IntPtr hwnd);
    void ApplyPropertiesToItem(IShellItem item); void ApplyPropertiesToItems(IntPtr items);
    void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
    void RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
    void MoveItem(IShellItem item, IShellItem folder, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
    void MoveItems(IntPtr items, IShellItem folder);
    void CopyItem(IShellItem item, IShellItem folder, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
    void CopyItems(IntPtr items, IShellItem folder);
    void DeleteItem(IShellItem item, IntPtr sink); void DeleteItems(IntPtr items);
    void NewItem(IShellItem folder, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name,
      [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
    void PerformOperations();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
  public static void Delete(string path) {
    IShellItem item;
    SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItem).GUID, out item);
    IFileOperation op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
    try { op.SetOperationFlags(0x0614); op.DeleteItem(item, IntPtr.Zero); op.PerformOperations(); }
    finally { Marshal.ReleaseComObject(op); Marshal.ReleaseComObject(item); }
  }
}
'@
[ShioriRemove]::Delete($env:SHIORI_REMOVE)`;
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

// A big gallery's folder takes a while; one that takes longer is left to the plain delete.
const TIMEOUT = 120_000;

function shellDelete(file) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { env: { ...process.env, SHIORI_REMOVE: file }, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), TIMEOUT);
    const done = () => { clearTimeout(timer); resolve(); };
    child.on('exit', done);
    child.on('error', done);
  });
}

// Delete `file` (an absolute path: a folder with everything in it, or a file) outright.
export async function removeOutright(file) {
  if (process.platform === 'win32') await shellDelete(file);
  if (fs.existsSync(file)) await fsp.rm(file, { recursive: true, force: true });
}
