using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace SSHDock.Native.Services;

// Only Windows Credential Manager persists secrets. There is no JSON fallback.
public static class CredentialVault
{
    private const uint Generic = 1;
    private const int NotFound = 1168;
    public static string? Read(string connectionId, string kind)
    {
        if (!CredRead(Target(connectionId, kind), Generic, 0, out var pointer))
        {
            var error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error, "无法读取 Windows 凭据管理器");
        }
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            var bytes = new byte[credential.BlobSize];
            if (bytes.Length > 0) Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
            try { return Encoding.UTF8.GetString(bytes); }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        finally { CredFree(pointer); }
    }
    public static void Save(string connectionId, string kind, string secret)
    {
        var bytes = Encoding.UTF8.GetBytes(secret);
        if (bytes.Length > 2560) { CryptographicOperations.ZeroMemory(bytes); throw new ArgumentException("凭据长度超过 Windows 凭据管理器上限"); }
        var blob = Marshal.AllocHGlobal(Math.Max(1, bytes.Length));
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential { Type = Generic, TargetName = Target(connectionId, kind), BlobSize = (uint)bytes.Length,
                Blob = blob, Persist = 2, UserName = "SSHDockNative" };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法保存 Windows 凭据；配置未使用明文回退");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
            for (var i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
            Marshal.FreeHGlobal(blob);
        }
    }
    public static void Delete(string connectionId)
    {
        foreach (var kind in new[] { "password", "passphrase" })
            if (!CredDelete(Target(connectionId, kind), Generic, 0) && Marshal.GetLastWin32Error() != NotFound)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法删除 Windows 凭据");
    }
    private static string Target(string id, string kind) => $"SSHDockNative/{id}/{kind}";
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags, Type;
        public string? TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")] private static extern void CredFree(IntPtr credential);
}
