using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

internal static class WindowsPipeFixture
{
    const uint TokenQuery = 8, GenericRead = 0x80000000, GenericWrite = 0x40000000, FileReadAttributes = 0x80, FileWriteAttributes = 0x100, WriteDac = 0x40000;
    const uint PipeAccessInbound = 1, PipeAccessOutbound = 2, FileFlagFirstPipeInstance = 0x80000, FileFlagOverlapped = 0x40000000, OpenExisting = 3;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr information, uint size, out uint returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static string PackageDacl(SecurityIdentifier identity)
    {
        IntPtr token = IntPtr.Zero, data = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TokenQuery, out token)) throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error().ToString());
            uint returned; GetTokenInformation(token, 6, IntPtr.Zero, 0, out returned);
            if (returned < IntPtr.Size || returned > 65536) throw new Exception("Invalid token default DACL size");
            data = Marshal.AllocHGlobal((int)returned);
            if (!GetTokenInformation(token, 6, data, returned, out returned)) throw new Exception("GetTokenInformation default DACL " + Marshal.GetLastWin32Error().ToString());
            IntPtr dacl = Marshal.ReadIntPtr(data);
            if (dacl == IntPtr.Zero) throw new Exception("Token default DACL missing");
            int length = (int)(ushort)Marshal.ReadInt16(dacl, 2);
            if (length < 8 || length > 65536) throw new Exception("Invalid token default DACL length");
            var bytes = new byte[length]; Marshal.Copy(dacl, bytes, 0, length);
            var acl = new RawAcl(bytes, 0);
            foreach (GenericAce ace in acl)
            {
                var qualified = ace as QualifiedAce;
                if (qualified != null && qualified.SecurityIdentifier.Equals(identity)) return qualified.AceQualifier + ":" + qualified.AceFlags + ":0x" + qualified.AccessMask.ToString("x8");
            }
            return "absent";
        }
        finally { if (data != IntPtr.Zero) Marshal.FreeHGlobal(data); if (token != IntPtr.Zero) CloseHandle(token); }
    }

    static string Probe(string scope, string kind, uint serverAccess, uint clientAccess)
    {
        string name = "\\\\?\\pipe\\" + scope + "agy-lpac-probe-" + Guid.NewGuid().ToString("N");
        IntPtr server = CreateNamedPipe(name, serverAccess | FileFlagFirstPipeInstance, 0, 1, 65536, 65536, 0, IntPtr.Zero);
        if (server == InvalidHandle) return scope + kind + "Create=" + Marshal.GetLastWin32Error().ToString();
        try
        {
            IntPtr client = CreateFile(name, clientAccess, 0, IntPtr.Zero, OpenExisting, FileFlagOverlapped, IntPtr.Zero);
            if (client == InvalidHandle) return scope + kind + "Open=" + Marshal.GetLastWin32Error().ToString();
            CloseHandle(client); return scope + kind + "Open=0";
        }
        finally { CloseHandle(server); }
    }

    static int Main()
    {
        try
        {
            IntPtr sid; uint returned;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(Process.GetCurrentProcess().Handle, TokenQuery, out token)) throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error().ToString());
                GetTokenInformation(token, 31, IntPtr.Zero, 0, out returned);
                if (returned < IntPtr.Size || returned > 65536) throw new Exception("Invalid package SID size");
                IntPtr package = Marshal.AllocHGlobal((int)returned);
                try { if (!GetTokenInformation(token, 31, package, returned, out returned)) throw new Exception("GetTokenInformation package SID " + Marshal.GetLastWin32Error().ToString()); sid = Marshal.ReadIntPtr(package); Console.WriteLine("packageDacl=" + PackageDacl(new SecurityIdentifier(sid))); }
                finally { Marshal.FreeHGlobal(package); }
            }
            finally { if (token != IntPtr.Zero) CloseHandle(token); }
            Console.WriteLine(Probe("global", "Stdin", PipeAccessInbound | PipeAccessOutbound | FileFlagOverlapped | WriteDac, GenericRead | FileWriteAttributes | WriteDac));
            Console.WriteLine(Probe("global", "Stdout", PipeAccessInbound | FileFlagOverlapped | WriteDac, GenericWrite | FileReadAttributes | WriteDac));
            Console.WriteLine(Probe("LOCAL\\", "Stdin", PipeAccessInbound | PipeAccessOutbound | FileFlagOverlapped | WriteDac, GenericRead | FileWriteAttributes | WriteDac));
            Console.WriteLine(Probe("LOCAL\\", "Stdout", PipeAccessInbound | FileFlagOverlapped | WriteDac, GenericWrite | FileReadAttributes | WriteDac));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 90; }
    }
}
