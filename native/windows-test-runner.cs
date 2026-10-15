using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class WindowsTestRunner
{
    const uint FileShareRead = 1, FileShareWrite = 2, OpenExisting = 3, FileFlagBackupSemantics = 0x02000000, FileFlagOpenReparsePoint = 0x00200000, InvalidFileAttributes = 0xffffffff;
    const uint WaitObject0 = 0, WaitTimeout = 0x102, ProcessQueryLimitedInformation = 0x1000, Synchronize = 0x100000;
    const uint DosRawTargetPath = 1, DosRemoveDefinition = 2, DosExactMatchOnRemove = 4, DosNoBroadcast = 8;
    const int ProcThreadAttributeSecurityCapabilities = 0x20009, ProcThreadAttributeHandleList = 0x20002, ProcThreadAttributeJobList = 0x2000D, ProcThreadAttributeAllApplicationPackagesPolicy = 0x2000F;
    const uint AllApplicationPackagesPolicyLpac = 1, JobObjectExtendedLimitInformation = 9, JobObjectLimitKillOnJobClose = 0x2000, JobObjectLimitActiveProcess = 0x8, JobObjectLimitBreakawayOk = 0x800, JobObjectLimitSilentBreakawayOk = 0x1000;
    public sealed class Request
    {
        public string action;
        public string nonce;
        public string profile;
        public string cwd;
        public string runtime;
        public string scratch;
        public string executable;
        public string[] args;
        public int timeoutSeconds;
        public int maxFiles;
        public int maxOutputChars;
        public bool network;
        public bool childProcesses;
        public string stateDirectory;
        public Grant[] grants;
        public Dictionary<string, string> environment;
    }

    public sealed class Grant
    {
        public string path;
        public string rights;
        public bool directory;
        public uint volume;
        public uint fileIndexHigh;
        public uint fileIndexLow;
    }

    public sealed class Lease
    {
        public int version;
        public string nonce;
        public string profile;
        public string sid;
        public string phase;
        public int controllerPid;
        public long controllerStarted;
        public string cwd;
        public string runtime;
        public string scratch;
        public Grant[] grants;
        public string logon;
        public AliasPlan[] aliases;
        public bool nullDeviceGrant;
        public bool? jobCreated;
    }

    public sealed class AliasPlan
    {
        public string kind;
        public string physicalRoot;
        public string customName;
        public string drive;
        public string aliasRoot;
        public string customTarget;
        public string driveTarget;
        public uint volume;
        public uint fileIndexHigh;
        public uint fileIndexLow;
        internal Mutex gate;
    }

    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr sid, capabilities; public uint count, reserved; }
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo
    {
        public int cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short showWindow, reservedSize; public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits
    {
        public long processTime, jobTime; public uint flags; public UIntPtr minimumWorkingSet, maximumWorkingSet;
        public uint activeProcesses; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct JobAccounting
    {
        public long totalUser, totalKernel, periodUser, periodKernel;
        public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; }
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint low; public int high; }
    [StructLayout(LayoutKind.Sequential)] struct TokenStatistics
    {
        public Luid tokenId, authenticationId; public long expiration; public uint tokenType, impersonationLevel, dynamicCharged, dynamicAvailable, groupCount, privilegeCount; public Luid modifiedId;
    }
    [StructLayout(LayoutKind.Sequential)] struct ByHandleFileInformation
    {
        public uint attributes; public FileTime created, accessed, written; public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }

    sealed class PinnedTarget : IDisposable
    {
        public Grant grant;
        public int maxFiles;
        public bool revokeLeaf;
        readonly List<IntPtr> handles = new List<IntPtr>();
        public void Add(IntPtr value) { handles.Add(value); }
        public void Dispose() { for (int index = handles.Count - 1; index >= 0; index--) if (handles[index] != IntPtr.Zero) CloseHandle(handles[index]); handles.Clear(); }
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr capabilities, out uint capabilityCount);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, IntPtr limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetKernelObjectSecurity(IntPtr handle, int securityInformation, byte[] pSecurityDescriptor, uint nLength, out uint lpnLengthNeeded);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetKernelObjectSecurity(IntPtr handle, int securityInformation, byte[] pSecurityDescriptor);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateMutex(IntPtr lpMutexAttributes, bool bInitialOwner, string lpName);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenMutex(uint dwDesiredAccess, bool bInheritHandle, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReleaseMutex(IntPtr hMutex);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetFileSecurity(string path, uint information, byte[] descriptor, uint length, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetFileSecurity(string path, uint information, byte[] descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr information, uint size, out uint returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation info);
    [StructLayout(LayoutKind.Sequential)] struct FileAttributeTagInfo { public uint attributes, tag; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, out FileAttributeTagInfo info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFileAttributes(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DefineDosDevice(uint flags, string name, string target);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint QueryDosDevice(string name, char[] target, uint max);
    [DllImport("secur32.dll")] static extern int LsaEnumerateLogonSessions(out uint count, out IntPtr sessions);
    [DllImport("secur32.dll")] static extern int LsaFreeReturnBuffer(IntPtr buffer);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint desiredAccess, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, IntPtr limits, uint size, IntPtr returned);

    static readonly IntPtr InvalidHandle = new IntPtr(-1);

    static void Check(bool success, string operation)
    {
        if (!success) { int code = Marshal.GetLastWin32Error(); throw new Win32Exception(code, operation + " (Win32 " + code + "): " + new Win32Exception(code).Message); }
    }
    static void CheckHr(int result, string operation) { if (result < 0) throw new Exception(operation + ": 0x" + result.ToString("x8")); }
    static bool IsNotFoundHresult(int value) { return value == unchecked((int)0x80070002) || value == unchecked((int)0x80070003); }
    static long FileTimeValue(FileTime value) { return ((long)value.high << 32) | value.low; }

    sealed class ControllerIdentity
    {
        public SecurityIdentifier user;
        public string logon;
    }

    static ControllerIdentity CurrentControllerIdentity()
    {
        IntPtr token;
        Check(OpenProcessToken(Process.GetCurrentProcess().Handle, 8, out token), "Open controller token");
        try
        {
            uint returned;
            GetTokenInformation(token, 1, IntPtr.Zero, 0, out returned);
            if (returned < IntPtr.Size || returned > 65536) throw new Exception("Invalid controller user token size");
            IntPtr userData = Marshal.AllocHGlobal(checked((int)returned));
            try
            {
                Check(GetTokenInformation(token, 1, userData, returned, out returned), "Read controller user token");
                var user = new SecurityIdentifier(Marshal.ReadIntPtr(userData));
                if (user.IsWellKnown(WellKnownSidType.LocalSystemSid)) throw new Exception("LocalSystem cannot create local DOS aliases");
                int size = Marshal.SizeOf(typeof(TokenStatistics)); IntPtr statisticsData = Marshal.AllocHGlobal(size);
                try
                {
                    Check(GetTokenInformation(token, 10, statisticsData, (uint)size, out returned), "Read controller logon token");
                    var statistics = (TokenStatistics)Marshal.PtrToStructure(statisticsData, typeof(TokenStatistics));
                    return new ControllerIdentity { user = user, logon = ((uint)statistics.authenticationId.high).ToString("x8") + "." + statistics.authenticationId.low.ToString("x8") };
                }
                finally { Marshal.FreeHGlobal(statisticsData); }
            }
            finally { Marshal.FreeHGlobal(userData); }
        }
        finally { CloseHandle(token); }
    }

    static bool TryParseLogon(string value, out Luid logon)
    {
        logon = new Luid();
        if (String.IsNullOrEmpty(value) || value.Length != 17 || value[8] != '.') return false;
        for (int index = 0; index < value.Length; index++) if (index != 8 && !((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f') || (value[index] >= 'A' && value[index] <= 'F'))) return false;
        uint high, low;
        if (!UInt32.TryParse(value.Substring(0, 8), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out high) || !UInt32.TryParse(value.Substring(9, 8), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out low)) return false;
        logon.high = unchecked((int)high); logon.low = low; return true;
    }

    static string DriveGateName(string logon, char letter)
    {
        Luid parsed; if (!TryParseLogon(logon, out parsed)) throw new Exception("Invalid logon identifier for DOS alias mutex");
        return "Global\\AGY.TEST.DOS." + logon + "." + letter;
    }

    static bool LogonSessionExists(string value)
    {
        Luid expected; if (!TryParseLogon(value, out expected)) throw new Exception("Invalid logon identifier for DOS alias recovery");
        uint count; IntPtr sessions; int status = LsaEnumerateLogonSessions(out count, out sessions);
        if (status != 0) throw new Exception("Enumerate logon sessions: 0x" + status.ToString("x8"));
        try
        {
            if (count > 1048576) throw new Exception("Logon session enumeration exceeded its bounded count");
            int size = Marshal.SizeOf(typeof(Luid));
            for (uint index = 0; index < count; index++)
            {
                var candidate = (Luid)Marshal.PtrToStructure(IntPtr.Add(sessions, checked((int)(index * (uint)size))), typeof(Luid));
                if (candidate.high == expected.high && candidate.low == expected.low) return true;
            }
            return false;
        }
        finally
        {
            if (sessions != IntPtr.Zero)
            {
                int released = LsaFreeReturnBuffer(sessions);
                if (released != 0) throw new Exception("Free logon session enumeration: 0x" + released.ToString("x8"));
            }
        }
    }

    static string[] QueryDosTargets(string name)
    {
        for (uint capacity = 256; capacity <= 65536; capacity *= 2)
        {
            var buffer = new char[checked((int)capacity)];
            uint length = QueryDosDevice(name, buffer, capacity);
            if (length != 0) return new String(buffer, 0, checked((int)length)).Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return null;
            if (error == 122) continue;
            throw new Win32Exception(error, "Query DOS device " + name);
        }
        throw new Exception("DOS device query exceeded its bounded buffer");
    }

    static void RequireDosAbsent(string name)
    {
        string[] targets = QueryDosTargets(name);
        if (targets != null) throw new Exception("DOS device is already defined: " + name);
    }

    static void RequireDosExact(string name, string target)
    {
        string[] targets = QueryDosTargets(name);
        if (targets == null || targets.Length != 1 || !String.Equals(targets[0], target, StringComparison.Ordinal)) throw new Exception("DOS device definition is missing, foreign, or stacked: " + name);
    }

    static Mutex AcquireDriveGate(char letter, ControllerIdentity controller)
    {
        var security = new MutexSecurity(); security.SetOwner(controller.user);
        security.AddAccessRule(new MutexAccessRule(controller.user, MutexRights.FullControl, AccessControlType.Allow));
        bool created; Mutex gate = new Mutex(true, DriveGateName(controller.logon, letter), out created, security);
        if (created) return gate;
        gate.Close(); return null;
    }

    static Mutex AcquireRecoveryDriveGate(char letter, ControllerIdentity controller, string logon)
    {
        var security = new MutexSecurity(); security.SetOwner(controller.user);
        security.AddAccessRule(new MutexAccessRule(controller.user, MutexRights.FullControl, AccessControlType.Allow));
        bool created, owned = false; Mutex gate = null;
        try
        {
            gate = new Mutex(false, DriveGateName(logon, letter), out created, security);
            try { owned = gate.WaitOne(0); }
            catch (AbandonedMutexException) { owned = true; }
            if (!owned) throw new Exception("DOS drive mutex is held: " + letter);
            return gate;
        }
        catch
        {
            if (gate != null) { if (owned) gate.ReleaseMutex(); gate.Close(); }
            throw;
        }
    }

    static string RawDosTarget(string value) { return "\\??\\" + value; }

    static AliasPlan[] CreateAliasPlan(Guid nonce, ControllerIdentity controller, PinnedTarget[] roots)
    {
        if (roots == null || roots.Length != 3) throw new Exception("Exactly three owned roots are required for DOS aliases");
        string[] kinds = new string[] { "copy", "runtime", "scratch" };
        var aliases = new AliasPlan[3]; int selected = 0;
        try
        {
            for (char letter = 'Z'; letter >= 'D' && selected < aliases.Length; letter--)
            {
                string drive = letter + ":"; if (QueryDosTargets(drive) != null) continue;
                Mutex gate = AcquireDriveGate(letter, controller); if (gate == null) continue;
                try
                {
                    if (QueryDosTargets(drive) != null) continue;
                    Grant root = roots[selected].grant;
                    if (!root.directory) throw new Exception("Owned DOS alias root is not a directory");
                    string custom = "AGY.TEST." + nonce.ToString("D").ToUpperInvariant() + "." + kinds[selected].ToUpperInvariant();
                    RequireDosAbsent(custom);
                    aliases[selected] = new AliasPlan { kind = kinds[selected], physicalRoot = root.path, customName = custom, drive = drive, aliasRoot = drive + "\\", customTarget = RawDosTarget(root.path), driveTarget = RawDosTarget(custom), volume = root.volume, fileIndexHigh = root.fileIndexHigh, fileIndexLow = root.fileIndexLow, gate = gate };
                    gate = null; selected++;
                }
                finally { if (gate != null) { gate.ReleaseMutex(); gate.Close(); } }
            }
            if (selected != aliases.Length) throw new Exception("Fewer than three unused DOS drive letters are available");
            return aliases;
        }
        catch { ReleaseAliasGates(aliases); throw; }
    }

    static void ReleaseAliasGates(AliasPlan[] aliases)
    {
        if (aliases == null) return;
        for (int index = aliases.Length - 1; index >= 0; index--) if (aliases[index] != null && aliases[index].gate != null)
        {
            aliases[index].gate.ReleaseMutex(); aliases[index].gate.Close(); aliases[index].gate = null;
        }
    }

    static void AcquireRecoveryAliasGates(AliasPlan[] aliases, ControllerIdentity controller, string logon)
    {
        try
        {
            for (int index = 0; index < aliases.Length; index++) aliases[index].gate = AcquireRecoveryDriveGate(aliases[index].drive[0], controller, logon);
        }
        catch { ReleaseAliasGates(aliases); throw; }
    }

    static void VerifyAliasRoot(AliasPlan alias)
    {
        IntPtr handle = CreateFile(alias.aliasRoot, 0, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open DOS alias root");
        try
        {
            ByHandleFileInformation info; Check(GetFileInformationByHandle(handle, out info), "Inspect DOS alias root");
            if ((info.attributes & (uint)FileAttributes.ReparsePoint) != 0 || (info.attributes & (uint)FileAttributes.Directory) == 0 || info.volume != alias.volume || info.indexHigh != alias.fileIndexHigh || info.indexLow != alias.fileIndexLow) throw new Exception("DOS alias root identity changed");
        }
        finally { CloseHandle(handle); }
    }

    static void DefineAlias(AliasPlan alias, bool drive)
    {
        string name = drive ? alias.drive : alias.customName, target = drive ? alias.driveTarget : alias.customTarget;
        RequireDosAbsent(name); Check(DefineDosDevice(DosRawTargetPath | DosNoBroadcast, name, target), "Define DOS device " + name); RequireDosExact(name, target);
    }

    static void ApplyAliases(AliasPlan[] aliases)
    {
        for (int index = 0; index < aliases.Length; index++) DefineAlias(aliases[index], false);
        for (int index = 0; index < aliases.Length; index++) DefineAlias(aliases[index], true);
        for (int index = 0; index < aliases.Length; index++) { RequireDosExact(aliases[index].customName, aliases[index].customTarget); RequireDosExact(aliases[index].drive, aliases[index].driveTarget); VerifyAliasRoot(aliases[index]); }
    }

    static void RemoveAlias(AliasPlan alias, bool drive)
    {
        string name = drive ? alias.drive : alias.customName, target = drive ? alias.driveTarget : alias.customTarget;
        string[] current = QueryDosTargets(name); if (current == null) return;
        if (current.Length != 1 || !String.Equals(current[0], target, StringComparison.Ordinal)) throw new Exception("DOS alias cleanup found a foreign or stacked definition: " + name);
        Check(DefineDosDevice(DosRawTargetPath | DosNoBroadcast | DosRemoveDefinition | DosExactMatchOnRemove, name, target), "Remove DOS device " + name);
        if (QueryDosTargets(name) != null) throw new Exception("DOS alias remained after exact cleanup: " + name);
    }

    static void RemoveAliases(AliasPlan[] aliases)
    {
        if (aliases == null) return;
        var failures = new List<string>();
        for (int index = aliases.Length - 1; index >= 0; index--) try { RemoveAlias(aliases[index], true); } catch (Exception error) { failures.Add(error.Message); }
        for (int index = aliases.Length - 1; index >= 0; index--) try { RemoveAlias(aliases[index], false); } catch (Exception error) { failures.Add(error.Message); }
        if (failures.Count != 0) throw new Exception(String.Join("; ", failures.ToArray()));
    }

    static bool IsPhysicalAbsolutePath(string value)
    {
        return !String.IsNullOrEmpty(value) && value.Length >= 3 && Char.IsLetter(value[0]) && value[1] == ':' && (value[2] == '\\' || value[2] == '/') && !value.StartsWith("\\\\", StringComparison.Ordinal) && value.IndexOf(':', 2) < 0;
    }

    static string ProjectOwnedPath(string value, AliasPlan[] aliases)
    {
        if (!IsPhysicalAbsolutePath(value)) return value;
        for (int index = 0; index < aliases.Length; index++)
        {
            string root = aliases[index].physicalRoot;
            if (value.Length < root.Length) continue;
            bool match = true;
            for (int character = 0; character < root.Length; character++)
            {
                char actual = value[character], expected = root[character];
                if ((actual == '\\' || actual == '/') && (expected == '\\' || expected == '/')) continue;
                if (Char.ToUpperInvariant(actual) != Char.ToUpperInvariant(expected)) { match = false; break; }
            }
            if (!match || (value.Length > root.Length && value[root.Length] != '\\' && value[root.Length] != '/')) continue;
            string tail = value.Substring(root.Length).TrimStart('\\', '/');
            foreach (string part in tail.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries)) if (part == "." || part == "..") return value;
            return aliases[index].aliasRoot + tail.Replace('/', '\\');
        }
        return value;
    }

    static string[] ProjectArguments(string[] arguments, AliasPlan[] aliases)
    {
        var projected = new string[arguments.Length]; for (int index = 0; index < arguments.Length; index++) projected[index] = ProjectOwnedPath(arguments[index], aliases); return projected;
    }

    static Dictionary<string, string> ProjectEnvironment(Request request, AliasPlan[] aliases)
    {
        string systemRoot = Environment.GetEnvironmentVariable("SystemRoot"); RequireLocalAbsolutePath(systemRoot, "SystemRoot");
        string system32 = Path.Combine(systemRoot, "System32");
        string system32Canonical = Path.GetFullPath(system32);
        var projected = new Dictionary<string, string>(request.environment, StringComparer.OrdinalIgnoreCase);
        AliasPlan runtime = aliases[1], scratch = aliases[2];

        string runtimePhysical = Path.GetFullPath(runtime.physicalRoot);
        string runtimeSeparator = runtimePhysical.EndsWith("\\") ? runtimePhysical : runtimePhysical + "\\";

        var pathEntries = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        pathEntries.Add(runtime.aliasRoot);
        seen.Add(runtime.aliasRoot);

        string rawPath;
        if (projected.TryGetValue("PATH", out rawPath) && !String.IsNullOrEmpty(rawPath))
        {
            string[] items = rawPath.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string rawItem in items)
            {
                string item = rawItem.Trim().Trim('"');
                if (String.IsNullOrEmpty(item)) continue;
                if (!IsPhysicalAbsolutePath(item)) continue;
                string full;
                try { full = Path.GetFullPath(item); } catch { continue; }
                if (!IsPhysicalAbsolutePath(full)) continue;

                if (String.Equals(full, system32Canonical, StringComparison.OrdinalIgnoreCase)) continue;

                bool isRuntimeOwned = String.Equals(full, runtimePhysical, StringComparison.OrdinalIgnoreCase) ||
                                      full.StartsWith(runtimeSeparator, StringComparison.OrdinalIgnoreCase);
                if (!isRuntimeOwned) continue;

                string mapped = ProjectOwnedPath(full, aliases);
                if (!mapped.StartsWith(runtime.aliasRoot, StringComparison.OrdinalIgnoreCase)) continue;

                if (seen.Add(mapped))
                {
                    pathEntries.Add(mapped);
                }
            }
        }

        if (seen.Add(system32))
        {
            pathEntries.Add(system32);
        }

        projected["PATH"] = String.Join(";", pathEntries.ToArray());
        foreach (string key in new string[] { "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA" }) projected[key] = scratch.aliasRoot;
        string comspec; if (!projected.TryGetValue("COMSPEC", out comspec)) comspec = Path.Combine(systemRoot, "System32", "cmd.exe"); projected["COMSPEC"] = ProjectOwnedPath(comspec, aliases);

        string gitExecPath;
        if (projected.TryGetValue("GIT_EXEC_PATH", out gitExecPath) && !String.IsNullOrEmpty(gitExecPath))
        {
            RequireLocalAbsolutePath(gitExecPath, "GIT_EXEC_PATH");
            string fullGitExec = Path.GetFullPath(gitExecPath);
            RequireLocalAbsolutePath(fullGitExec, "GIT_EXEC_PATH");
            bool isInsideRuntime = String.Equals(fullGitExec, runtimePhysical, StringComparison.OrdinalIgnoreCase) ||
                                  fullGitExec.StartsWith(runtimeSeparator, StringComparison.OrdinalIgnoreCase);
            if (!isInsideRuntime) throw new Exception("GIT_EXEC_PATH must be located inside the runtime directory: " + gitExecPath);
            string projectedGitExec = ProjectOwnedPath(fullGitExec, aliases);
            if (!projectedGitExec.StartsWith(runtime.aliasRoot, StringComparison.OrdinalIgnoreCase)) throw new Exception("GIT_EXEC_PATH projection failed: " + gitExecPath);
            projected["GIT_EXEC_PATH"] = projectedGitExec;

            var poisonKeys = new List<string>();
            foreach (string envKey in projected.Keys)
            {
                if (String.Equals(envKey, "GIT_CONFIG_COUNT", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(envKey, "GIT_CONFIG_PARAMETERS", StringComparison.OrdinalIgnoreCase) ||
                    envKey.StartsWith("GIT_CONFIG_KEY_", StringComparison.OrdinalIgnoreCase) ||
                    envKey.StartsWith("GIT_CONFIG_VALUE_", StringComparison.OrdinalIgnoreCase))
                {
                    poisonKeys.Add(envKey);
                }
            }
            foreach (string poisonKey in poisonKeys)
            {
                projected.Remove(poisonKey);
            }

            AliasPlan copyAlias = aliases[0];
            string copyAliasRoot = copyAlias.aliasRoot;
            var safeDirectories = new List<string>();
            safeDirectories.Add("");
            safeDirectories.Add(copyAliasRoot);

            int copyMaxFiles = request.maxFiles;
            if (copyMaxFiles < 1) throw new Exception("Invalid repository discovery file limit");
            string copyPhysicalRoot = Path.GetFullPath(copyAlias.physicalRoot);
            var nestedRepos = new List<string>();
            DiscoverNestedGitRepositories(copyPhysicalRoot, copyPhysicalRoot, copyMaxFiles, new int[] { 0 }, nestedRepos);
            nestedRepos.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string nestedRepo in nestedRepos)
            {
                string projectedNested = ProjectOwnedPath(nestedRepo, aliases);
                if (projectedNested.StartsWith(copyAliasRoot, StringComparison.OrdinalIgnoreCase) && !safeDirectories.Contains(projectedNested))
                {
                    safeDirectories.Add(projectedNested);
                }
            }

            projected["GIT_CONFIG_COUNT"] = safeDirectories.Count.ToString();
            for (int index = 0; index < safeDirectories.Count; index++)
            {
                projected["GIT_CONFIG_KEY_" + index.ToString()] = "safe.directory";
                projected["GIT_CONFIG_VALUE_" + index.ToString()] = safeDirectories[index];
            }
        }

        string gitConfigGlobal;
        if (projected.TryGetValue("GIT_CONFIG_GLOBAL", out gitConfigGlobal) && !String.IsNullOrEmpty(gitConfigGlobal))
        {
            RequireLocalAbsolutePath(gitConfigGlobal, "GIT_CONFIG_GLOBAL");
            string fullGitConfig = Path.GetFullPath(gitConfigGlobal);
            RequireLocalAbsolutePath(fullGitConfig, "GIT_CONFIG_GLOBAL");
            string scratchPhysical = Path.GetFullPath(scratch.physicalRoot);
            string scratchSeparator = scratchPhysical.EndsWith("\\") ? scratchPhysical : scratchPhysical + "\\";
            bool isInsideScratch = String.Equals(fullGitConfig, scratchPhysical, StringComparison.OrdinalIgnoreCase) ||
                                  fullGitConfig.StartsWith(scratchSeparator, StringComparison.OrdinalIgnoreCase);
            if (!isInsideScratch) throw new Exception("GIT_CONFIG_GLOBAL must be located inside the scratch directory: " + gitConfigGlobal);
            string projectedGitConfig = ProjectOwnedPath(fullGitConfig, aliases);
            if (!projectedGitConfig.StartsWith(scratch.aliasRoot, StringComparison.OrdinalIgnoreCase)) throw new Exception("GIT_CONFIG_GLOBAL projection failed: " + gitConfigGlobal);
            projected["GIT_CONFIG_GLOBAL"] = projectedGitConfig;
        }

        return projected;
    }

    static List<Dictionary<string, string>> PathMappings(AliasPlan[] aliases)
    {
        var mappings = new List<Dictionary<string, string>>(); foreach (AliasPlan alias in aliases) mappings.Add(new Dictionary<string, string> { { "kind", alias.kind }, { "aliasRoot", alias.aliasRoot }, { "physicalRoot", alias.physicalRoot } }); return mappings;
    }

    static void RequireLocalAbsolutePath(string value, string description)
    {
        if (String.IsNullOrEmpty(value) || value.IndexOf('\0') >= 0 || value.StartsWith("\\\\", StringComparison.Ordinal) || value.StartsWith("//", StringComparison.Ordinal) ||
            value.StartsWith("\\\\?\\", StringComparison.Ordinal) || value.StartsWith("\\\\.\\", StringComparison.Ordinal) || value.Length < 3 ||
            !Char.IsLetter(value[0]) || value[1] != ':' || (value[2] != '\\' && value[2] != '/')) throw new Exception(description + " must be a local absolute path");
        if (value.IndexOf(':', 2) >= 0) throw new Exception(description + " cannot use an alternate data stream");
    }

    static string OwnedTemporaryPath(string directory, string prefix)
    {
        RequireLocalAbsolutePath(directory, "Directory");
        string full = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        string parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        if (!String.Equals(Path.GetDirectoryName(full), parent, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(full).StartsWith(prefix, StringComparison.Ordinal)) throw new Exception("Directory is not owned temporary storage");
        return full;
    }

    static string OwnedDirectory(string directory, string prefix)
    {
        string full = OwnedTemporaryPath(directory, prefix);
        if (!Directory.Exists(full) || (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new Exception("Directory was replaced or linked");
        return full;
    }

    static string StateLeaseDirectory(string stateDirectory)
    {
        RequireLocalAbsolutePath(stateDirectory, "State directory");
        string state = Path.GetFullPath(stateDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if (!Directory.Exists(state) || (File.GetAttributes(state) & FileAttributes.ReparsePoint) != 0) throw new Exception("State directory is unavailable or linked");
        string lease = Path.Combine(state, "windows-lpac-leases");
        if (!Directory.Exists(lease)) Directory.CreateDirectory(lease);
        if ((File.GetAttributes(lease) & FileAttributes.ReparsePoint) != 0) throw new Exception("Lease directory is linked");
        return lease;
    }

    // Cloud Files placeholders keep their path identity; links and unknown tags remain forbidden.
    static bool IsCloudTag(uint tag) { return (tag & 0xFFFF0FFF) == 0x9000001A; }

    static void ValidatePathComponents(string full, PinnedTarget target, bool walkTree, int maxFiles, bool isRevoke = false)
    {
        RequireLocalAbsolutePath(full, "Permission target");
        string canonical = Path.GetFullPath(full).TrimEnd(Path.DirectorySeparatorChar);
        if (String.Equals(canonical + Path.DirectorySeparatorChar, Path.GetPathRoot(canonical), StringComparison.OrdinalIgnoreCase)) throw new Exception("Permission target cannot be a volume root");
        string root = Path.GetPathRoot(canonical), tail = canonical.Substring(root.Length), current = root;
        if (tail.Length == 0) throw new Exception("Permission target cannot be a volume root");
        string[] pieces = tail.Split(new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
        for (int index = 0; index < pieces.Length; index++)
        {
            current = Path.Combine(current, pieces[index]);
            IntPtr handle = CreateFile(current, 0, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
            if (handle == InvalidHandle) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open permission target");
            try
            {
                ByHandleFileInformation info; Check(GetFileInformationByHandle(handle, out info), "Inspect permission target");
                bool isReparse = (info.attributes & (uint)FileAttributes.ReparsePoint) != 0;
                bool isCloud = false;
                if (isReparse)
                {
                    FileAttributeTagInfo tagInfo;
                    Check(GetFileInformationByHandleEx(handle, 9, out tagInfo, 8), "Inspect permission target reparse tag");
                    if (IsCloudTag(tagInfo.tag))
                    {
                        isCloud = true;
                    }
                    else
                    {
                        if (!isRevoke || index < pieces.Length - 1) throw new Exception("Permission target contains an unsafe reparse point");
                    }
                }
                bool directory = (info.attributes & (uint)FileAttributes.Directory) != 0;
                if (index < pieces.Length - 1 && !directory) throw new Exception("Permission target component is not a directory");
                if (index == pieces.Length - 1)
                {
                    if (!directory && !isRevoke && info.links > 1) throw new Exception("Permission target file has multiple hard links");
                    if (isRevoke && isReparse && !isCloud) target.revokeLeaf = true;
                    target.grant.path = canonical; target.grant.directory = directory; target.grant.volume = info.volume; target.grant.fileIndexHigh = info.indexHigh; target.grant.fileIndexLow = info.indexLow;
                }
                target.Add(handle); handle = IntPtr.Zero;
            }
            finally { if (handle != IntPtr.Zero && handle != InvalidHandle) CloseHandle(handle); }
        }
        if (walkTree && target.grant.directory) ScanTree(canonical, maxFiles, new int[] { 0 });
    }

    static void ScanTree(string directory, int maxFiles, int[] count)
    {
        foreach (string child in Directory.GetFileSystemEntries(directory))
        {
            if (++count[0] > maxFiles) throw new Exception("Permission directory exceeds the configured file limit");
            var temporary = new PinnedTarget { grant = new Grant { rights = "read" } };
            try { ValidatePathComponents(child, temporary, false, maxFiles); if (temporary.grant.directory) ScanTree(child, maxFiles, count); }
            finally { temporary.Dispose(); }
        }
    }

    static void DiscoverNestedGitRepositories(string rootDirectory, string currentDirectory, int maxFiles, int[] count, List<string> discovered)
    {
        foreach (string child in Directory.GetFileSystemEntries(currentDirectory))
        {
            if (++count[0] > maxFiles) throw new Exception("Copy directory exceeds the configured file limit during repository discovery");
            var temporary = new PinnedTarget { grant = new Grant { rights = "read" } };
            try
            {
                ValidatePathComponents(child, temporary, false, maxFiles);
                if (temporary.grant.directory)
                {
                    string name = Path.GetFileName(child);
                    if (String.Equals(name, ".git", StringComparison.OrdinalIgnoreCase))
                    {
                        if (!String.Equals(currentDirectory, rootDirectory, StringComparison.OrdinalIgnoreCase))
                        {
                            discovered.Add(currentDirectory);
                        }
                    }
                    else
                    {
                        DiscoverNestedGitRepositories(rootDirectory, child, maxFiles, count, discovered);
                    }
                }
            }
            finally { temporary.Dispose(); }
        }
    }

    static PinnedTarget PinGrant(Grant supplied, int maxFiles)
    {
        if (supplied == null || (supplied.rights != "read" && supplied.rights != "modify")) throw new Exception("Invalid permission grant");
        var target = new PinnedTarget { grant = new Grant { path = supplied.path, rights = supplied.rights }, maxFiles = maxFiles };
        try { ValidatePathComponents(supplied.path, target, Directory.Exists(supplied.path), maxFiles); return target; }
        catch { target.Dispose(); throw; }
    }

    static PinnedTarget PinRevokeTarget(Grant supplied, int maxFiles)
    {
        if (supplied == null || (supplied.rights != "read" && supplied.rights != "modify")) throw new Exception("Invalid permission grant");
        var target = new PinnedTarget { grant = new Grant { path = supplied.path, rights = supplied.rights }, maxFiles = maxFiles };
        try { ValidatePathComponents(supplied.path, target, false, maxFiles, true); return target; }
        catch { target.Dispose(); throw; }
    }

    static bool SameIdentity(Grant expected, Grant actual)
    {
        return expected.directory == actual.directory && expected.volume == actual.volume && expected.fileIndexHigh == actual.fileIndexHigh && expected.fileIndexLow == actual.fileIndexLow;
    }

    static FileSystemRights RightsFor(Grant grant) { return grant.rights == "modify" ? FileSystemRights.Modify | FileSystemRights.Synchronize : FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize; }

    static RawSecurityDescriptor ReadDacl(string path)
    {
        uint needed;
        if (!GetFileSecurity(path, 4, null, 0, out needed) && Marshal.GetLastWin32Error() != 122) Check(false, "Measure target DACL");
        if (needed == 0 || needed > 1024 * 1024) throw new Exception("Invalid target DACL size");
        var data = new byte[needed];
        Check(GetFileSecurity(path, 4, data, needed, out needed), "Read target DACL");
        return new RawSecurityDescriptor(data, 0);
    }

    static bool SameDacl(RawSecurityDescriptor expected, RawSecurityDescriptor actual)
    {
        if (expected.ControlFlags != actual.ControlFlags || expected.DiscretionaryAcl == null || actual.DiscretionaryAcl == null || expected.DiscretionaryAcl.BinaryLength != actual.DiscretionaryAcl.BinaryLength) return false;
        var left = new byte[expected.DiscretionaryAcl.BinaryLength]; var right = new byte[actual.DiscretionaryAcl.BinaryLength];
        expected.DiscretionaryAcl.GetBinaryForm(left, 0); actual.DiscretionaryAcl.GetBinaryForm(right, 0);
        for (int index = 0; index < left.Length; index++) if (left[index] != right[index]) return false;
        return true;
    }

    const int RevokeFileBudget = 1000000;

    static void AddCleanupFailure(List<string> failures, string message)
    {
        if (failures.Count > 25 || (failures.Count == 1 && failures[0] == OversizedDiagnosticMessage)) return;
        if (failures.Count == 25) message = "Additional cleanup failures omitted";
        long length = message.Length;
        foreach (string failure in failures) length += failure.Length + 2;
        if (length > MaxDiagnosticCharacters)
        {
            failures.Clear(); failures.Add(OversizedDiagnosticMessage);
        }
        else failures.Add(message);
    }

    static void Access(PinnedTarget target, SecurityIdentifier identity, bool grant)
    {
        if (!grant)
        {
            using (PinnedTarget fresh = PinRevokeTarget(target.grant, RevokeFileBudget))
            {
                if (!SameIdentity(target.grant, fresh.grant)) throw new Exception("Granted target identity changed");
                AccessTree(fresh, identity, false, true, RevokeFileBudget, new int[] { 0 });
            }
            return;
        }
        AccessTree(target, identity, true, true, target.maxFiles, new int[] { 0 });
    }

    static void AccessTree(PinnedTarget target, SecurityIdentifier identity, bool grant, bool root, int maxFiles, int[] count)
    {
        string rootFailure = null;
        try
        {
            // Read the stored descriptor: GetAccessControl infers inherited flags on legacy DACLs.
            RawSecurityDescriptor descriptor = ReadDacl(target.grant.path);
            if (grant && !root && (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0) return;
            RawAcl acl = descriptor.DiscretionaryAcl;
            bool changed = false;
            if (acl == null && grant) throw new Exception("Permission target has no DACL");
            if (acl != null)
            {
                int rights = (int)RightsFor(target.grant); CommonAce existing = null;
                for (int index = acl.Count - 1; index >= 0; index--)
                {
                    KnownAce ace = acl[index] as KnownAce;
                    if (ace == null || !identity.Equals(ace.SecurityIdentifier)) continue;
                    if (!grant) { acl.RemoveAce(index); changed = true; }
                    else
                    {
                        CommonAce allow = ace as CommonAce;
                        if (allow == null || allow.AceQualifier != AceQualifier.AccessAllowed || allow.IsCallback) throw new Exception("Unexpected owned permission rule");
                        existing = allow;
                        if ((allow.AccessMask & rights) != rights) { allow.AccessMask |= rights; changed = true; }
                    }
                }
                if (grant && existing == null)
                {
                    AceFlags flags = target.grant.directory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit : AceFlags.None;
                    if (!root && (descriptor.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0) flags |= AceFlags.Inherited;
                    int insert = acl.Count;
                    if ((flags & AceFlags.Inherited) == 0) for (int index = 0; index < acl.Count; index++) if ((acl[index].AceFlags & AceFlags.Inherited) != 0) { insert = index; break; }
                    acl.InsertAce(insert, new CommonAce(flags, AceQualifier.AccessAllowed, rights, identity, false, null)); changed = true;
                }
                if (changed)
                {
                    ControlFlags storedFlags = descriptor.ControlFlags;
                    // AR preserves AI in this non-propagating write; Windows consumes AR.
                    if ((storedFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0) descriptor.SetFlags(storedFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
                    var data = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(data, 0);
                    Check(SetFileSecurity(target.grant.path, 4, data), "Write target DACL");
                    descriptor.SetFlags(storedFlags);
                    if (!SameDacl(descriptor, ReadDacl(target.grant.path))) throw new Exception("Target DACL update was not preserved exactly");
                }
            }
        }
        catch (Exception error)
        {
            if (grant) throw;
            rootFailure = Path.GetFileName(target.grant.path) + " DACL: " + error.Message;
        }

        // SetFileSecurity preserves stored ACEs but does not propagate to existing children.
        if (!target.grant.directory || (!grant && target.revokeLeaf))
        {
            if (rootFailure != null) throw new Exception(CombineDiagnostic(rootFailure, null));
            return;
        }

        List<string> childFailures = null;
        try
        {
            foreach (string child in Directory.EnumerateFileSystemEntries(target.grant.path))
            {
                if (++count[0] > maxFiles)
                {
                    if (grant) throw new Exception("Permission directory exceeds the configured file limit");
                    if (childFailures == null) childFailures = new List<string>();
                    AddCleanupFailure(childFailures, "Permission directory exceeds cleanup file limit");
                    break;
                }
                using (var pin = new PinnedTarget { grant = new Grant { rights = target.grant.rights }, maxFiles = maxFiles })
                {
                    try
                    {
                        ValidatePathComponents(child, pin, false, maxFiles, !grant);
                        AccessTree(pin, identity, grant, false, maxFiles, count);
                    }
                    catch (Exception error)
                    {
                        if (grant) throw;
                        if (childFailures == null) childFailures = new List<string>();
                        AddCleanupFailure(childFailures, Path.GetFileName(child) + ": " + error.Message);
                    }
                }
            }
        }
        catch (Exception enumError)
        {
            if (grant) throw;
            if (childFailures == null) childFailures = new List<string>();
            AddCleanupFailure(childFailures, "Enumerate: " + enumError.Message);
        }

        var allFailures = new List<string>();
        if (rootFailure != null) AddCleanupFailure(allFailures, rootFailure);
        if (childFailures != null) foreach (string failure in childFailures) AddCleanupFailure(allFailures, failure);
        if (allFailures.Count != 0) throw new Exception(String.Join("; ", allFailures.ToArray()));
    }

    const string NullDeviceKernelPath = @"\\?\GLOBALROOT\Device\Null";
    const uint StandardRightsRead = 0x00020000;
    const uint StandardRightsWriteDac = 0x00040000;
    const int NullDeviceAccessRights = 0x12019f; // FILE_GENERIC_READ | FILE_GENERIC_WRITE union
    static readonly SecurityIdentifier AllRestrictedPackagesSid = new SecurityIdentifier("S-1-15-2-2");
    static readonly SecurityIdentifier WorldSid = new SecurityIdentifier("S-1-1-0");

    sealed class NullDeviceGate : IDisposable
    {
        const string MutexName = "Global\\AGY.TEST.NULL_DEVICE.MUTEX";
        const uint MutexSynchronizeAndModify = 0x00100001; // SYNCHRONIZE | MUTEX_MODIFY_STATE
        IntPtr handle = IntPtr.Zero;
        bool owned = false;

        public static NullDeviceGate Acquire(int timeoutMilliseconds = 30000)
        {
            var gate = new NullDeviceGate();
            try
            {
                gate.OpenOrCreate();
                uint wait = WaitForSingleObject(gate.handle, checked((uint)timeoutMilliseconds));
                if (wait == WaitObject0 || wait == 0x80)
                {
                    gate.owned = true;
                    return gate;
                }
                if (wait == WaitTimeout) throw new Exception("Null device mutex wait timed out");
                int err = Marshal.GetLastWin32Error();
                throw new Win32Exception(err, "Wait for Null device mutex (Win32 " + err + ")");
            }
            catch
            {
                gate.Dispose();
                throw;
            }
        }

        void OpenOrCreate()
        {
            handle = OpenMutex(MutexSynchronizeAndModify, false, MutexName);
            if (handle != IntPtr.Zero) return;
            int err = Marshal.GetLastWin32Error();
            if (err != 2 && err != 1168) throw new Win32Exception(err, "Open Null device mutex (Win32 " + err + ")");

            var security = new MutexSecurity();
            security.AddAccessRule(new MutexAccessRule(WorldSid, MutexRights.Synchronize | MutexRights.Modify, AccessControlType.Allow));
            byte[] sdBytes = security.GetSecurityDescriptorBinaryForm();
            IntPtr pSd = Marshal.AllocHGlobal(sdBytes.Length);
            try
            {
                Marshal.Copy(sdBytes, 0, pSd, sdBytes.Length);
                var sa = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = pSd, inherit = 0 };
                IntPtr pSa = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityAttributes)));
                try
                {
                    Marshal.StructureToPtr(sa, pSa, false);
                    handle = CreateMutex(pSa, false, MutexName);
                    if (handle == IntPtr.Zero)
                    {
                        int createErr = Marshal.GetLastWin32Error();
                        handle = OpenMutex(MutexSynchronizeAndModify, false, MutexName);
                        if (handle == IntPtr.Zero) throw new Win32Exception(createErr, "Create Null device mutex (Win32 " + createErr + ")");
                    }
                }
                finally { Marshal.FreeHGlobal(pSa); }
            }
            finally { Marshal.FreeHGlobal(pSd); }
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                if (owned)
                {
                    ReleaseMutex(handle);
                    owned = false;
                }
                CloseHandle(handle);
                handle = IntPtr.Zero;
            }
        }
    }

    internal static RawSecurityDescriptor ReadKernelDacl(IntPtr handle)
    {
        uint needed;
        GetKernelObjectSecurity(handle, 4, null, 0, out needed);
        int err = Marshal.GetLastWin32Error();
        if (err != 0 && err != 122) Check(false, "Measure kernel object DACL");
        if (needed < 20 || needed > 65536) throw new Exception("Invalid kernel object DACL size: " + needed);
        byte[] buffer = new byte[needed];
        Check(GetKernelObjectSecurity(handle, 4, buffer, needed, out needed), "Read kernel object DACL");
        return new RawSecurityDescriptor(buffer, 0);
    }

    internal static void WriteKernelDacl(IntPtr handle, RawSecurityDescriptor descriptor)
    {
        byte[] buffer = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(buffer, 0);
        Check(SetKernelObjectSecurity(handle, 4, buffer), "Write kernel object DACL");
    }

    internal static bool IsStockNullAccessSufficient(RawSecurityDescriptor descriptor, SecurityIdentifier childSid)
    {
        if (descriptor == null || descriptor.DiscretionaryAcl == null) return false;
        RawAcl acl = descriptor.DiscretionaryAcl;
        for (int i = 0; i < acl.Count; i++)
        {
            CommonAce ace = acl[i] as CommonAce;
            if (ace != null && ace.AceQualifier == AceQualifier.AccessDenied)
            {
                if ((ace.SecurityIdentifier.Equals(AllRestrictedPackagesSid) ||
                     ace.SecurityIdentifier.Equals(WorldSid) ||
                     (childSid != null && ace.SecurityIdentifier.Equals(childSid))) &&
                    (ace.AccessMask & NullDeviceAccessRights) != 0)
                {
                    return false;
                }
            }
        }
        for (int i = 0; i < acl.Count; i++)
        {
            CommonAce ace = acl[i] as CommonAce;
            if (ace != null && ace.AceQualifier == AceQualifier.AccessAllowed &&
                !ace.IsCallback && (ace.AceFlags & AceFlags.InheritOnly) == 0 &&
                ace.SecurityIdentifier.Equals(AllRestrictedPackagesSid))
            {
                if ((ace.AccessMask & NullDeviceAccessRights) == NullDeviceAccessRights)
                {
                    return true;
                }
            }
        }
        return false;
    }

    internal static RawSecurityDescriptor ApplyNullDeviceAceToDescriptor(RawSecurityDescriptor descriptor, SecurityIdentifier identity)
    {
        if (descriptor == null || descriptor.DiscretionaryAcl == null) throw new ArgumentNullException("descriptor");
        if (identity == null) throw new ArgumentNullException("identity");
        const ControlFlags supported = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected | ControlFlags.SelfRelative;
        if ((descriptor.ControlFlags & ~supported) != 0) throw new Exception("Unsupported Null device DACL control flags: 0x" + ((int)descriptor.ControlFlags).ToString("x4"));
        RawAcl acl = descriptor.DiscretionaryAcl;
        for (int i = 0; i < acl.Count; i++)
        {
            CommonAce ace = acl[i] as CommonAce;
            if (ace == null || ace.IsCallback) throw new Exception("Unexpected ACE in Null device DACL");
            if (ace.AceQualifier == AceQualifier.AccessDenied &&
                (ace.SecurityIdentifier.Equals(identity) || ace.SecurityIdentifier.Equals(AllRestrictedPackagesSid) || ace.SecurityIdentifier.Equals(WorldSid)) &&
                (ace.AccessMask & NullDeviceAccessRights) != 0)
            {
                throw new Exception("Explicit deny on Null device DACL prevents execution access");
            }
            if (ace.SecurityIdentifier.Equals(identity))
            {
                throw new Exception("Duplicate or unexpected existing owned ACE for execution SID in Null device DACL");
            }
        }
        var newAce = new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, NullDeviceAccessRights, identity, false, null);
        int insertIndex = 0;
        while (insertIndex < acl.Count && ((CommonAce)acl[insertIndex]).AceQualifier == AceQualifier.AccessDenied)
        {
            insertIndex++;
        }
        acl.InsertAce(insertIndex, newAce);
        return descriptor;
    }

    internal static bool RemoveNullDeviceAceFromDescriptor(RawSecurityDescriptor descriptor, SecurityIdentifier identity, bool requirePresent)
    {
        if (descriptor == null || descriptor.DiscretionaryAcl == null) throw new ArgumentNullException("descriptor");
        if (identity == null) throw new ArgumentNullException("identity");
        RawAcl acl = descriptor.DiscretionaryAcl;
        int foundIndex = -1;
        int matchCount = 0;
        for (int i = 0; i < acl.Count; i++)
        {
            CommonAce ace = acl[i] as CommonAce;
            if (ace != null && ace.SecurityIdentifier.Equals(identity))
            {
                matchCount++;
                foundIndex = i;
                if (ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None ||
                    ace.AccessMask != NullDeviceAccessRights || ace.IsCallback)
                {
                    throw new Exception("Unexpected owned permission rule on Null device DACL");
                }
            }
        }
        if (matchCount > 1) throw new Exception("Duplicate owned ACEs on Null device DACL for execution SID");
        if (matchCount == 0)
        {
            if (requirePresent) throw new Exception("Expected owned ACE on Null device DACL was missing");
            return false;
        }
        acl.RemoveAce(foundIndex);
        return true;
    }

    internal static void VerifyDaclPreservation(RawSecurityDescriptor original, RawSecurityDescriptor updated, SecurityIdentifier addedSid, SecurityIdentifier removedSid)
    {
        if (original.ControlFlags != updated.ControlFlags) throw new Exception("Control flags were not preserved");
        RawAcl originalAcl = original.DiscretionaryAcl, updatedAcl = updated.DiscretionaryAcl;
        if (addedSid != null)
        {
            if (updatedAcl.Count != originalAcl.Count + 1) throw new Exception("Updated DACL count mismatch after addition");
            int origIdx = 0;
            for (int i = 0; i < updatedAcl.Count; i++)
            {
                CommonAce ace = updatedAcl[i] as CommonAce;
                if (ace != null && ace.SecurityIdentifier.Equals(addedSid))
                {
                    if (ace.AceQualifier != AceQualifier.AccessAllowed || ace.AceFlags != AceFlags.None || ace.AccessMask != NullDeviceAccessRights)
                        throw new Exception("Added ACE properties do not match expected grant");
                    continue;
                }
                if (origIdx >= originalAcl.Count) throw new Exception("Foreign ACE count mismatch");
                CommonAce origAce = originalAcl[origIdx++] as CommonAce;
                if (origAce == null || ace == null || origAce.AceQualifier != ace.AceQualifier || origAce.AceFlags != ace.AceFlags ||
                    origAce.AccessMask != ace.AccessMask || !origAce.SecurityIdentifier.Equals(ace.SecurityIdentifier))
                    throw new Exception("Foreign ACE was not preserved exactly");
            }
        }
        else if (removedSid != null)
        {
            if (updatedAcl.Count != originalAcl.Count - 1) throw new Exception("Updated DACL count mismatch after removal");
            int updIdx = 0;
            for (int i = 0; i < originalAcl.Count; i++)
            {
                CommonAce ace = originalAcl[i] as CommonAce;
                if (ace != null && ace.SecurityIdentifier.Equals(removedSid)) continue;
                if (updIdx >= updatedAcl.Count) throw new Exception("Foreign ACE count mismatch");
                CommonAce updAce = updatedAcl[updIdx++] as CommonAce;
                if (updAce == null || ace == null || updAce.AceQualifier != ace.AceQualifier || updAce.AceFlags != ace.AceFlags ||
                    updAce.AccessMask != ace.AccessMask || !updAce.SecurityIdentifier.Equals(ace.SecurityIdentifier))
                    throw new Exception("Foreign ACE was not preserved exactly");
            }
        }
    }

    internal static void ApplyKernelObjectGrant(IntPtr handle, SecurityIdentifier identity)
    {
        RawSecurityDescriptor before = ReadKernelDacl(handle);
        if (IsStockNullAccessSufficient(before, identity)) return;
        byte[] cloneBytes = new byte[before.BinaryLength];
        before.GetBinaryForm(cloneBytes, 0);
        RawSecurityDescriptor toModify = new RawSecurityDescriptor(cloneBytes, 0);
        ApplyNullDeviceAceToDescriptor(toModify, identity);
        WriteKernelDacl(handle, toModify);
        RawSecurityDescriptor verified = ReadKernelDacl(handle);
        if (!SameDacl(toModify, verified)) throw new Exception("Kernel object DACL update was not preserved exactly");
        VerifyDaclPreservation(before, verified, identity, null);
    }

    internal static bool RemoveKernelObjectGrant(IntPtr handle, SecurityIdentifier identity, bool requirePresent)
    {
        RawSecurityDescriptor before = ReadKernelDacl(handle);
        byte[] cloneBytes = new byte[before.BinaryLength];
        before.GetBinaryForm(cloneBytes, 0);
        RawSecurityDescriptor toModify = new RawSecurityDescriptor(cloneBytes, 0);
        bool removed = RemoveNullDeviceAceFromDescriptor(toModify, identity, requirePresent);
        if (!removed) return false;
        WriteKernelDacl(handle, toModify);
        RawSecurityDescriptor verified = ReadKernelDacl(handle);
        if (!SameDacl(toModify, verified)) throw new Exception("Kernel object DACL cleanup was not preserved exactly");
        VerifyDaclPreservation(before, verified, null, identity);
        return true;
    }

    static bool NullDeviceRequiresGrant(SecurityIdentifier identity)
    {
            IntPtr handle = CreateFile(NullDeviceKernelPath, StandardRightsRead, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (handle == InvalidHandle) Check(false, "Open Null device for inspection");
            try
            {
                RawSecurityDescriptor descriptor = ReadKernelDacl(handle);
                return !IsStockNullAccessSufficient(descriptor, identity);
            }
            finally { CloseHandle(handle); }
    }

    static void ApplyNullDeviceGrant(SecurityIdentifier identity)
    {
        using (NullDeviceGate.Acquire())
        {
            IntPtr handle = CreateFile(NullDeviceKernelPath, StandardRightsRead | StandardRightsWriteDac, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (handle == InvalidHandle)
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, "Open Null device for DACL modification (Win32 " + error + "): " + new Win32Exception(error).Message);
            }
            try
            {
                ApplyKernelObjectGrant(handle, identity);
            }
            finally { CloseHandle(handle); }
        }
    }

    static void ReconcileRecoveryNullDeviceGrant(SecurityIdentifier identity)
    {
        using (NullDeviceGate.Acquire())
        {
            IntPtr inspect = CreateFile(NullDeviceKernelPath, StandardRightsRead, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (inspect == InvalidHandle) Check(false, "Inspect pending Null device grant");
            try
            {
                RawSecurityDescriptor current = ReadKernelDacl(inspect);
                if (!RemoveNullDeviceAceFromDescriptor(current, identity, false)) return;
            }
            finally { CloseHandle(inspect); }
            IntPtr handle = CreateFile(NullDeviceKernelPath, StandardRightsRead | StandardRightsWriteDac, FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (handle == InvalidHandle)
            {
                int error = Marshal.GetLastWin32Error();
                throw new Win32Exception(error, "Open Null device for recovery DACL cleanup (Win32 " + error + "): " + new Win32Exception(error).Message);
            }
            try
            {
                RemoveKernelObjectGrant(handle, identity, false);
            }
            finally { CloseHandle(handle); }
        }
    }

    static string ExecutionJobName(Lease lease) { return "Global\\AGY.TEST.JOB." + Guid.ParseExact(lease.nonce, "D").ToString("N"); }

    static IntPtr CreateExecutionJob(Lease lease, SecurityIdentifier user)
    {
        var acl = new RawAcl(RawAcl.AclRevision, 2);
        acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x1f003f, user, false, null));
        acl.InsertAce(1, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x1f003f, new SecurityIdentifier("S-1-5-18"), false, null));
        var descriptor = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected, user, null, null, acl);
        var bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
        IntPtr sd = Marshal.AllocHGlobal(bytes.Length), sa = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityAttributes)));
        try
        {
            Marshal.Copy(bytes, 0, sd, bytes.Length);
            Marshal.StructureToPtr(new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = sd, inherit = 0 }, sa, false);
            IntPtr created = CreateJobObject(sa, ExecutionJobName(lease)); Check(created != IntPtr.Zero, "Create owned execution job");
            if (Marshal.GetLastWin32Error() == 183) { CloseHandle(created); throw new Exception("Execution job already exists"); }
            return created;
        }
        finally { Marshal.FreeHGlobal(sa); Marshal.FreeHGlobal(sd); }
    }

    internal static void WaitForEmptyJob(IntPtr job, int timeoutMilliseconds)
    {
        var timer = Stopwatch.StartNew(); IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JobAccounting)));
        try
        {
            for (;;)
            {
                Check(QueryInformationJobObject(job, 1, data, (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero), "Verify owned job process count");
                if (((JobAccounting)Marshal.PtrToStructure(data, typeof(JobAccounting))).activeProcesses == 0) return;
                if (timer.ElapsedMilliseconds >= timeoutMilliseconds) throw new Exception("Owned job processes have not terminated");
                Thread.Sleep(10);
            }
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    static void VerifyRecoveryJobEnded(Lease lease)
    {
        if (lease.version < 3 || lease.jobCreated != true) return;
        IntPtr job = OpenJobObject(4, false, ExecutionJobName(lease));
        if (job == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 2 || error == 1168) return;
            throw new Win32Exception(error, "Inspect interrupted execution job (Win32 " + error + ")");
        }
        try { WaitForEmptyJob(job, 5000); }
        finally { CloseHandle(job); }
    }

    static string Quote(string argument)
    {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character); slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }

    static long CurrentProcessStart()
    {
        FileTime created, exited, kernel, user;
        Check(GetProcessTimes(Process.GetCurrentProcess().Handle, out created, out exited, out kernel, out user), "Read controller start time");
        return FileTimeValue(created);
    }

    static void WriteLease(string path, Lease lease, bool initial, JavaScriptSerializer serializer)
    {
        byte[] data = new UTF8Encoding(false).GetBytes(serializer.Serialize(lease));
        if (initial)
        {
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(data, 0, data.Length); stream.Flush(true); }
            return;
        }
        string temporary = path + ".update." + Process.GetCurrentProcess().Id.ToString() + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(data, 0, data.Length); stream.Flush(true); }
        try { File.Replace(temporary, path, null); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    static void ValidateLease(Lease lease, string expectedFile)
    {
        Guid nonce;
        if (lease == null || (lease.version != 1 && lease.version != 2 && lease.version != 3) || !Guid.TryParseExact(lease.nonce, "D", out nonce) || String.IsNullOrEmpty(lease.profile) ||
            !String.Equals(lease.profile, "agy.test." + nonce.ToString("N"), StringComparison.Ordinal) || Path.GetFileName(expectedFile) != nonce.ToString("N") + ".json" ||
            lease.controllerPid <= 0 || lease.controllerStarted <= 0 || lease.grants == null || (lease.phase != "creating" && lease.phase != "active" && lease.phase != "cleanup-failed")) throw new Exception("Invalid Windows LPAC lease");
        if (lease.phase != "creating" && String.IsNullOrEmpty(lease.sid)) throw new Exception("Lease has no profile identity");
        OwnedTemporaryPath(lease.cwd, "agy-mcp-copy-"); OwnedTemporaryPath(lease.runtime, "agy-mcp-runtime-"); OwnedTemporaryPath(lease.scratch, "agy-mcp-scratch-");
        if (lease.version == 2 || lease.version == 3) ValidateLeaseAliases(lease, nonce);
        if (lease.version < 3 && (lease.nullDeviceGrant || lease.jobCreated == true)) throw new Exception("Legacy lease cannot declare Null device grant or named job");
        if (lease.version == 3 && !lease.jobCreated.HasValue) throw new Exception("Lease has no job creation state");
        if ((lease.nullDeviceGrant || lease.jobCreated == true) && (lease.phase == "creating" || String.IsNullOrEmpty(lease.sid))) throw new Exception("Lease has no verified execution identity");
    }

    static void ValidateLeaseAliases(Lease lease, Guid nonce)
    {
        Luid logon; if (!TryParseLogon(lease.logon, out logon) || lease.aliases == null || lease.aliases.Length != 3) throw new Exception("Invalid Windows LPAC alias lease");
        string[] kinds = new string[] { "copy", "runtime", "scratch" }, roots = new string[] { lease.cwd, lease.runtime, lease.scratch }; var drives = new HashSet<char>();
        for (int index = 0; index < lease.aliases.Length; index++)
        {
            AliasPlan alias = lease.aliases[index];
            if (alias == null || !String.Equals(alias.kind, kinds[index], StringComparison.Ordinal) || !String.Equals(alias.physicalRoot, roots[index], StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(alias.customName, "AGY.TEST." + nonce.ToString("D").ToUpperInvariant() + "." + kinds[index].ToUpperInvariant(), StringComparison.Ordinal) ||
                String.IsNullOrEmpty(alias.drive) || alias.drive.Length != 2 || alias.drive[0] < 'D' || alias.drive[0] > 'Z' || alias.drive[1] != ':' || !drives.Add(alias.drive[0]) || (index != 0 && alias.drive[0] >= lease.aliases[index - 1].drive[0]) || !String.Equals(alias.aliasRoot, alias.drive + "\\", StringComparison.Ordinal) ||
                !String.Equals(alias.customTarget, RawDosTarget(roots[index]), StringComparison.Ordinal) || !String.Equals(alias.driveTarget, RawDosTarget(alias.customName), StringComparison.Ordinal)) throw new Exception("Invalid Windows LPAC alias plan");
        }
    }

    static bool ControllerIsActive(Lease lease)
    {
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, (uint)lease.controllerPid);
        if (process == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == 87 || error == 1168) return false;
            throw new Win32Exception(error, "Cannot verify lease controller");
        }
        try
        {
            FileTime created, exited, kernel, user;
            Check(GetProcessTimes(process, out created, out exited, out kernel, out user), "Verify lease controller start time");
            uint state = WaitForSingleObject(process, 0);
            if (state == WaitTimeout) return FileTimeValue(created) == lease.controllerStarted;
            if (state == WaitObject0) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Verify lease controller state");
        }
        finally { CloseHandle(process); }
    }

    static SecurityIdentifier LeaseIdentity(Lease lease)
    {
        if (String.IsNullOrEmpty(lease.sid))
        {
            if (lease.phase == "creating") return null;
            throw new Exception("Lease has no profile identity");
        }
        var identity = new SecurityIdentifier(lease.sid);
        IntPtr derived; int result = DeriveAppContainerSidFromAppContainerName(lease.profile, out derived);
        if (result >= 0 && derived != IntPtr.Zero)
        {
            try { if (!identity.Equals(new SecurityIdentifier(derived))) throw new Exception("Lease profile SID does not match its profile name"); }
            finally { FreeSid(derived); }
        }
        else if (!IsNotFoundHresult(result)) CheckHr(result, "Verify lease profile SID");
        return identity;
    }

    static bool IsMissingOwnedTemporaryGrant(Lease lease, Grant grant)
    {
        if (grant == null || !grant.directory) return false;
        string directory = null, prefix = null;
        if (String.Equals(grant.path, lease.cwd, StringComparison.OrdinalIgnoreCase)) { directory = lease.cwd; prefix = "agy-mcp-copy-"; }
        else if (String.Equals(grant.path, lease.runtime, StringComparison.OrdinalIgnoreCase)) { directory = lease.runtime; prefix = "agy-mcp-runtime-"; }
        else if (String.Equals(grant.path, lease.scratch, StringComparison.OrdinalIgnoreCase)) { directory = lease.scratch; prefix = "agy-mcp-scratch-"; }
        else return false;
        directory = OwnedTemporaryPath(directory, prefix);
        if (GetFileAttributes(directory) != InvalidFileAttributes) return false;
        int error = Marshal.GetLastWin32Error();
        return error == 2 || error == 3;
    }

    static void DeleteProfile(string profile)
    {
        int result = DeleteAppContainerProfile(profile);
        if (result < 0 && !IsNotFoundHresult(result)) CheckHr(result, "Delete AppContainer profile");
    }

    static void Recover(string stateDirectory, Dictionary<string, object> result, JavaScriptSerializer serializer)
    {
        string directory = StateLeaseDirectory(stateDirectory); var failures = new List<string>(); int recovered = 0, active = 0;
        foreach (string file in Directory.GetFiles(directory, "*.json", SearchOption.TopDirectoryOnly))
        {
            try
            {
                if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new Exception("Lease file is linked");
                Lease lease = serializer.Deserialize<Lease>(File.ReadAllText(file, Encoding.UTF8)); ValidateLease(lease, file);
                if (ControllerIsActive(lease)) { active++; continue; }
                SecurityIdentifier identity = LeaseIdentity(lease); VerifyRecoveryJobEnded(lease); var pins = new List<PinnedTarget>(); var cleanupFailures = new List<string>();
                try
                {
                    if (lease.version == 2 || lease.version == 3)
                    {
                        try
                        {
                            ControllerIdentity controller = CurrentControllerIdentity();
                            if (String.Equals(controller.logon, lease.logon, StringComparison.Ordinal))
                            {
                                AcquireRecoveryAliasGates(lease.aliases, controller, lease.logon);
                                try { RemoveAliases(lease.aliases); }
                                finally { ReleaseAliasGates(lease.aliases); }
                            }
                            else if (LogonSessionExists(lease.logon)) throw new Exception("Lease logon session remains active");
                        }
                        catch (Exception error) { cleanupFailures.Add("DOS aliases: " + error.Message); }
                    }
                    if (lease.version == 3 && lease.nullDeviceGrant && identity != null)
                    {
                        try { ReconcileRecoveryNullDeviceGrant(identity); }
                        catch (Exception error) { cleanupFailures.Add("Null device: " + error.Message); }
                    }
                    if (identity != null)
                    {
                        for (int index = lease.grants.Length - 1; index >= 0; index--)
                        {
                            if (IsMissingOwnedTemporaryGrant(lease, lease.grants[index])) continue;
                            try { Access(new PinnedTarget { grant = lease.grants[index] }, identity, false); }
                            catch (Exception error) { cleanupFailures.Add("ACL " + index.ToString() + ": " + error.Message); }
                        }
                    }
                    try { DeleteProfile(lease.profile); } catch (Exception error) { cleanupFailures.Add("Profile: " + error.Message); }
                }
                finally { for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose(); }
                if (cleanupFailures.Count != 0)
                {
                    if (!String.IsNullOrEmpty(lease.sid)) lease.phase = "cleanup-failed";
                    try { WriteLease(file, lease, false, serializer); } catch (Exception update) { cleanupFailures.Add("Lease: " + update.Message); }
                    throw new Exception(String.Join("; ", cleanupFailures.ToArray()));
                }
                File.Delete(file); recovered++;
            }
            catch (Exception error) { failures.Add(Path.GetFileName(file) + ": " + error.Message); }
        }
        result["recovered"] = recovered; result["active"] = active;
        if (failures.Count != 0) result["error"] = "Windows LPAC recovery failed: " + String.Join("; ", failures.ToArray());
    }

    static IntPtr DeriveCapability(string name, List<IntPtr> allocations)
    {
        IntPtr groups, caps; uint groupCount, capabilityCount;
        Check(DeriveCapabilitySidsFromName(name, out groups, out groupCount, out caps, out capabilityCount), "Derive " + name + " capability");
        try
        {
            if (capabilityCount != 1) throw new Exception("Unexpected " + name + " capability count");
            IntPtr sid = Marshal.ReadIntPtr(caps); allocations.Add(sid); return sid;
        }
        finally
        {
            for (int index = 0; index < (int)groupCount; index++) LocalFree(Marshal.ReadIntPtr(groups, index * IntPtr.Size));
            if (groups != IntPtr.Zero) LocalFree(groups);
            if (caps != IntPtr.Zero) LocalFree(caps);
        }
    }

    static void AddGrant(List<Grant> grants, string path, string rights)
    {
        if (String.IsNullOrEmpty(path)) throw new Exception("Missing owned permission target");
        foreach (Grant existing in grants) if (String.Equals(existing.path, path, StringComparison.OrdinalIgnoreCase)) { if (rights == "modify") existing.rights = "modify"; return; }
        grants.Add(new Grant { path = path, rights = rights });
    }

    static bool IsBridgeOwnedTemporaryPath(string value)
    {
        foreach (string part in value.Split(new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (part.StartsWith("agy-mcp-copy-", StringComparison.OrdinalIgnoreCase) || part.StartsWith("agy-mcp-baseline-", StringComparison.OrdinalIgnoreCase) ||
                part.StartsWith("agy-mcp-runtime-", StringComparison.OrdinalIgnoreCase) || part.StartsWith("agy-mcp-controller-", StringComparison.OrdinalIgnoreCase) ||
                part.StartsWith("agy-mcp-scratch-", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    const int MaxDiagnosticCharacters = 64000;
    internal const string OversizedDiagnosticMessage = "Execution diagnostic omitted: exceeded 64000 characters [truncated]";

    internal static string CombineDiagnostic(string primary, string secondary)
    {
        long length = (primary == null ? 0 : primary.Length) + (long)(secondary == null ? 0 : secondary.Length);
        if (!String.IsNullOrEmpty(primary) && !String.IsNullOrEmpty(secondary)) length += 2;
        if (length > MaxDiagnosticCharacters) return OversizedDiagnosticMessage;
        if (String.IsNullOrEmpty(primary)) return secondary ?? "";
        if (String.IsNullOrEmpty(secondary)) return primary;
        return primary + "; " + secondary;
    }

    static int Main(string[] arguments)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var serializer = new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024 };
        var result = new Dictionary<string, object>();
        string profile = null, leaseFile = null, cwd = null, runtime = null, scratch = null;
        SecurityIdentifier identity = null; Lease lease = null;
        ControllerIdentity controller = null; AliasPlan[] aliases = null;
        IntPtr sid = IntPtr.Zero, job = IntPtr.Zero, attributes = IntPtr.Zero, capabilityData = IntPtr.Zero, lpacData = IntPtr.Zero, handleData = IntPtr.Zero, jobData = IntPtr.Zero, envData = IntPtr.Zero, capabilityList = IntPtr.Zero;
        IntPtr read = IntPtr.Zero, write = IntPtr.Zero, inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo(); bool attributesInitialized = false, profileCreated = false, nullDeviceGranted = false;
        var pins = new List<PinnedTarget>(); var applied = new List<PinnedTarget>();
        var capabilitySids = new List<IntPtr>();
        var output = new StringBuilder(); bool truncated = false; Thread reader = null; object jobGate = new object(); int cancellation = 0;
        try
        {
            if (arguments.Length != 1) throw new Exception("One controller request file is required");
            var request = serializer.Deserialize<Request>(File.ReadAllText(arguments[0], Encoding.UTF8));
            if (request == null || String.IsNullOrEmpty(request.action)) throw new Exception("Invalid controller request");
            if (request.action == "recover")
            {
                Recover(request.stateDirectory, result, serializer); result["output"] = ""; result["truncated"] = false;
                Console.WriteLine(serializer.Serialize(result)); return result.ContainsKey("error") ? 1 : 0;
            }
            if (request.action != "write" && request.action != "read-only") throw new Exception("Invalid controller action");
            Guid nonce; if (!Guid.TryParseExact(request.nonce, "D", out nonce)) throw new Exception("Invalid nonce");
            if (!String.Equals(request.profile, "agy.test." + nonce.ToString("N"), StringComparison.Ordinal)) throw new Exception("Invalid deterministic profile name");
            result["nonce"] = request.nonce;
            if (request.timeoutSeconds < 1 || request.timeoutSeconds > 86400 || request.maxFiles < 1 || request.maxFiles > 1000000 || request.maxOutputChars < 256 || request.maxOutputChars > 64000 || request.args == null || request.environment == null || request.grants == null) throw new Exception("Invalid request");
            if (request.args.Length > 50) throw new Exception("Too many command arguments");
            foreach (string argument in request.args) if (argument == null || argument.Length > 4000 || argument.IndexOf('\0') >= 0) throw new Exception("Invalid command argument");
            cwd = OwnedDirectory(request.cwd, "agy-mcp-copy-"); runtime = OwnedDirectory(request.runtime, "agy-mcp-runtime-"); scratch = OwnedDirectory(request.scratch, "agy-mcp-scratch-");
            string executable = Path.GetFullPath(request.executable);
            if (!executable.StartsWith(runtime + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(executable) || (File.GetAttributes(executable) & FileAttributes.ReparsePoint) != 0) throw new Exception("Executable must be staged inside the runtime");
            var requestedGrants = new List<Grant>();
            AddGrant(requestedGrants, cwd, request.action == "read-only" ? "read" : "modify");
            AddGrant(requestedGrants, runtime, "read"); AddGrant(requestedGrants, scratch, "modify");
            foreach (Grant grant in request.grants)
            {
                if (grant == null || IsBridgeOwnedTemporaryPath(grant.path)) throw new Exception("External permission grant targets bridge-owned temporary storage");
                AddGrant(requestedGrants, grant.path, grant.rights);
            }
            if (requestedGrants.Count > 23) throw new Exception("Too many permission grants");
            foreach (Grant grant in requestedGrants) pins.Add(PinGrant(grant, request.maxFiles));
            string state = StateLeaseDirectory(request.stateDirectory);
            profile = request.profile; leaseFile = Path.Combine(state, nonce.ToString("N") + ".json");
            controller = CurrentControllerIdentity(); aliases = CreateAliasPlan(nonce, controller, new PinnedTarget[] { pins[0], pins[1], pins[2] });
            result["pathMappings"] = PathMappings(aliases);
            lease = new Lease { version = 3, nonce = request.nonce, profile = profile, phase = "creating", controllerPid = Process.GetCurrentProcess().Id, controllerStarted = CurrentProcessStart(), cwd = cwd, runtime = runtime, scratch = scratch, grants = new Grant[0], logon = controller.logon, aliases = aliases, nullDeviceGrant = false, jobCreated = false };
            WriteLease(leaseFile, lease, true, serializer);
            CheckHr(CreateAppContainerProfile(profile, profile, "Isolated test process", IntPtr.Zero, 0, out sid), "CreateAppContainerProfile");
            profileCreated = true; identity = new SecurityIdentifier(sid);
            lease.sid = identity.Value; WriteLease(leaseFile, lease, false, serializer);
            Directory.CreateDirectory(Path.Combine(scratch, "Packages", profile, "AC", "Temp"));
            Directory.CreateDirectory(Path.Combine(scratch, "Packages", profile, "AC", "Local"));
            bool needNullGrant = request.environment.ContainsKey("GIT_EXEC_PATH") && NullDeviceRequiresGrant(identity);
            var recorded = new List<Grant>(); foreach (PinnedTarget pin in pins) recorded.Add(pin.grant);
            lease.sid = identity.Value; lease.grants = recorded.ToArray(); lease.nullDeviceGrant = needNullGrant; lease.phase = "active"; WriteLease(leaseFile, lease, false, serializer);
            if (needNullGrant)
            {
                nullDeviceGranted = true;
                ApplyNullDeviceGrant(identity);
            }
            foreach (PinnedTarget pin in pins) { applied.Add(pin); Access(pin, identity, true); }
            ApplyAliases(aliases); result["pathMappings"] = PathMappings(aliases);

            var inheritable = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), inherit = 1 };
            Check(CreatePipe(out read, out write, ref inheritable, 0), "Create output pipe"); Check(SetHandleInformation(read, 1, 0), "Protect output reader");
            Check(CreatePipe(out inputRead, out inputWrite, ref inheritable, 0), "Create input pipe"); CloseHandle(inputWrite); inputWrite = IntPtr.Zero;
            job = CreateExecutionJob(lease, controller.user);
            lease.jobCreated = true; WriteLease(leaseFile, lease, false, serializer);
            var limits = new ExtendedLimits(); limits.basic.flags = JobObjectLimitKillOnJobClose | (request.childProcesses ? 0u : JobObjectLimitActiveProcess); limits.basic.activeProcesses = request.childProcesses ? 0u : 1u; IntPtr limitData = Marshal.AllocHGlobal(Marshal.SizeOf(limits));
            try { Marshal.StructureToPtr(limits, limitData, false); Check(SetInformationJobObject(job, (int)JobObjectExtendedLimitInformation, limitData, (uint)Marshal.SizeOf(limits)), "Require job cleanup"); Marshal.DestroyStructure(limitData, typeof(ExtendedLimits)); Check(QueryInformationJobObject(job, (int)JobObjectExtendedLimitInformation, limitData, (uint)Marshal.SizeOf(limits), IntPtr.Zero), "Verify job limits"); var observed = (ExtendedLimits)Marshal.PtrToStructure(limitData, typeof(ExtendedLimits)); if ((observed.basic.flags & JobObjectLimitKillOnJobClose) == 0 || (observed.basic.flags & (JobObjectLimitBreakawayOk | JobObjectLimitSilentBreakawayOk)) != 0 || (!request.childProcesses && ((observed.basic.flags & JobObjectLimitActiveProcess) == 0 || observed.basic.activeProcesses != 1))) throw new Exception("Job limits were not applied"); }
            finally { Marshal.FreeHGlobal(limitData); }
            DeriveCapability("registryRead", capabilitySids);
            if (request.network) { DeriveCapability("internetClient", capabilitySids); DeriveCapability("privateNetworkClientServer", capabilitySids); }
                int sidAndAttributesSize = Marshal.SizeOf(typeof(SidAndAttributes)); capabilityList = Marshal.AllocHGlobal(sidAndAttributesSize * capabilitySids.Count);
                for (int index = 0; index < capabilitySids.Count; index++) Marshal.StructureToPtr(new SidAndAttributes { sid = capabilitySids[index], attributes = 4 }, IntPtr.Add(capabilityList, index * sidAndAttributesSize), false);
                var caps = new SecurityCapabilities { sid = sid, capabilities = capabilityList, count = (uint)capabilitySids.Count };
                capabilityData = Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps, capabilityData, false);
                int attributeCount = 4; UIntPtr size = UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
                attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64())); Check(InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref size), "Initialize attributes"); attributesInitialized = true;
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(ProcThreadAttributeSecurityCapabilities), capabilityData, new UIntPtr((uint)Marshal.SizeOf(caps)), IntPtr.Zero, IntPtr.Zero), "Set AppContainer");
                lpacData = Marshal.AllocHGlobal(4); Marshal.WriteInt32(lpacData, (int)AllApplicationPackagesPolicyLpac);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(ProcThreadAttributeAllApplicationPackagesPolicy), lpacData, new UIntPtr(4), IntPtr.Zero, IntPtr.Zero), "Require LPAC");
                handleData = Marshal.AllocHGlobal(IntPtr.Size * 2); Marshal.WriteIntPtr(handleData, write); Marshal.WriteIntPtr(handleData, IntPtr.Size, inputRead);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(ProcThreadAttributeHandleList), handleData, new UIntPtr((uint)(IntPtr.Size * 2)), IntPtr.Zero, IntPtr.Zero), "Restrict inherited handles");
                jobData = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobData, job);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(ProcThreadAttributeJobList), jobData, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Assign job at process creation");
            var startup = new StartupInfoEx(); startup.startup.cb = Marshal.SizeOf(startup); startup.startup.flags = 0x100; startup.startup.input = inputRead; startup.startup.output = write; startup.startup.error = write; startup.attributes = attributes;
            string aliasExecutable = ProjectOwnedPath(executable, aliases), aliasCwd = ProjectOwnedPath(cwd, aliases); if (String.Equals(aliasExecutable, executable, StringComparison.OrdinalIgnoreCase) || String.Equals(aliasCwd, cwd, StringComparison.OrdinalIgnoreCase)) throw new Exception("Owned paths were not projected to DOS aliases");
            var command = new StringBuilder(Quote(aliasExecutable)); foreach (string argument in ProjectArguments(request.args, aliases)) command.Append(' ').Append(Quote(argument));
            Dictionary<string, string> projectedEnvironment = ProjectEnvironment(request, aliases); var environment = new StringBuilder(); var keys = new List<string>(projectedEnvironment.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string key in keys) { string value = projectedEnvironment[key]; if (String.IsNullOrEmpty(key) || value == null || key.IndexOfAny(new char[] { '=', '\0' }) >= 0 || value.IndexOf('\0') >= 0) throw new Exception("Invalid environment"); environment.Append(key).Append('=').Append(value).Append('\0'); }
            environment.Append('\0'); envData = Marshal.StringToHGlobalUni(environment.ToString());
            Check(CreateProcess(aliasExecutable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | 0x4 | 0x8000000, envData, aliasCwd, ref startup, out child), "Create isolated process");
            foreach (IntPtr capability in capabilitySids) if (capability != IntPtr.Zero) LocalFree(capability);
            capabilitySids.Clear();
            bool inJob; Check(IsProcessInJob(child.process, job, out inJob) && inJob, "Verify isolated job");
            IntPtr token; Check(OpenProcessToken(child.process, 8, out token), "Inspect child token");
            try
            {
                IntPtr info = Marshal.AllocHGlobal(IntPtr.Size); uint returned;
                try
                {
                    Check(GetTokenInformation(token, 29, info, (uint)IntPtr.Size, out returned), "Verify AppContainer token"); if (Marshal.ReadInt32(info) != 1) throw new Exception("AppContainer token missing");
                    GetTokenInformation(token, 31, IntPtr.Zero, 0, out returned); if (returned < IntPtr.Size || returned > 65536) throw new Exception("Invalid package identity size"); IntPtr packageInfo = Marshal.AllocHGlobal(checked((int)returned));
                    try { Check(GetTokenInformation(token, 31, packageInfo, returned, out returned), "Verify package identity"); if (!identity.Equals(new SecurityIdentifier(Marshal.ReadIntPtr(packageInfo)))) throw new Exception("Package identity mismatch"); }
                    finally { Marshal.FreeHGlobal(packageInfo); }
                }
                finally { Marshal.FreeHGlobal(info); }
            }
            finally { CloseHandle(token); }
            for (int index = 0; index < aliases.Length; index++) { RequireDosExact(aliases[index].customName, aliases[index].customTarget); RequireDosExact(aliases[index].drive, aliases[index].driveTarget); VerifyAliasRoot(aliases[index]); }
            var cancelReader = new Thread(delegate() { string message = Console.ReadLine(); if (message == null || message == "cancel " + request.nonce) { Interlocked.Exchange(ref cancellation, 1); lock (jobGate) { if (job != IntPtr.Zero) TerminateJobObject(job, 125); } } }); cancelReader.IsBackground = true; cancelReader.Start();
            CloseHandle(write); write = IntPtr.Zero; CloseHandle(inputRead); inputRead = IntPtr.Zero; IntPtr outputHandle = read; read = IntPtr.Zero;
            reader = new Thread(delegate() { using (var stream = new FileStream(new SafeFileHandle(outputHandle, true), FileAccess.Read)) using (var text = new StreamReader(stream, Encoding.UTF8)) { char[] buffer = new char[2048]; int count; while ((count = text.Read(buffer, 0, buffer.Length)) != 0) { output.Append(buffer, 0, count); if (output.Length > request.maxOutputChars) { truncated = true; output.Remove(0, output.Length - request.maxOutputChars); } } } }); reader.Start();
            if (ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Resume isolated process");
            result["pid"] = child.pid; result["sandbox"] = "windows-lpac";
            uint wait = WaitForSingleObject(child.process, checked((uint)request.timeoutSeconds * 1000));
            if (wait == WaitTimeout) { result["error"] = "Command timed out"; Check(TerminateJobObject(job, 124), "Terminate timed out job"); if (WaitForSingleObject(child.process, 5000) != WaitObject0) throw new Exception("Timed out process did not terminate"); }
            else if (wait != WaitObject0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for isolated process");
            uint exit; Check(GetExitCodeProcess(child.process, out exit), "Read exit code"); result["exitCode"] = exit;
            for (int index = 0; index < aliases.Length; index++) { RequireDosExact(aliases[index].customName, aliases[index].customTarget); RequireDosExact(aliases[index].drive, aliases[index].driveTarget); VerifyAliasRoot(aliases[index]); }
            if (Interlocked.CompareExchange(ref cancellation, 0, 0) != 0) result["error"] = "Command cancelled";
        }
        catch (Exception error) { result["error"] = error.Message; result["exitCode"] = null; }
        finally
        {
            var failures = new List<string>(); bool jobEnded = true;
            lock (jobGate)
            {
                if (job != IntPtr.Zero)
                {
                    try { Check(TerminateJobObject(job, 125), "Terminate owned job"); WaitForEmptyJob(job, 5000); }
                    catch (Exception error) { jobEnded = false; failures.Add("Job: " + error.Message); }
                    finally { CloseHandle(job); job = IntPtr.Zero; }
                }
            }
            if (write != IntPtr.Zero) CloseHandle(write);
            if (reader != null && !reader.Join(5000))
            {
                result["error"] = CombineDiagnostic(result.ContainsKey("error") && result["error"] != null ? result["error"].ToString() : null, "Output reader did not terminate");
            }
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread); if (child.process != IntPtr.Zero) CloseHandle(child.process); if (read != IntPtr.Zero) CloseHandle(read); if (inputRead != IntPtr.Zero) CloseHandle(inputRead); if (inputWrite != IntPtr.Zero) CloseHandle(inputWrite);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr pointer in new IntPtr[] { attributes, capabilityData, capabilityList, lpacData, handleData, jobData, envData }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
            foreach (IntPtr capability in capabilitySids) if (capability != IntPtr.Zero) LocalFree(capability);
            if (jobEnded)
            {
                if (aliases != null) try { RemoveAliases(aliases); result["aliasesDeleted"] = true; } catch (Exception error) { failures.Add("DOS aliases: " + error.Message); } finally { ReleaseAliasGates(aliases); }
                if (nullDeviceGranted) try { ReconcileRecoveryNullDeviceGrant(identity); } catch (Exception error) { failures.Add("Null device: " + error.Message); }
                for (int index = applied.Count - 1; index >= 0; index--) try { Access(applied[index], identity, false); } catch (Exception error) { failures.Add("ACL " + index.ToString() + ": " + error.Message); }
                if (profileCreated) try { DeleteProfile(profile); result["profileDeleted"] = true; } catch (Exception error) { failures.Add("Profile: " + error.Message); }
            }
            else if (aliases != null) ReleaseAliasGates(aliases);
            for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
            if (sid != IntPtr.Zero) FreeSid(sid);
            if (leaseFile != null)
            {
                if (failures.Count == 0 && profileCreated) { try { File.Delete(leaseFile); } catch (Exception error) { failures.Add("Lease: " + error.Message); } }
                if (failures.Count != 0) try { if (lease != null && !String.IsNullOrEmpty(lease.sid)) { lease.phase = "cleanup-failed"; WriteLease(leaseFile, lease, false, serializer); } } catch (Exception error) { failures.Add("Lease: " + error.Message); }
            }
            if (failures.Count != 0)
            {
                result["error"] = CombineDiagnostic(result.ContainsKey("error") && result["error"] != null ? result["error"].ToString() : null, "Cleanup failed: " + String.Join("; ", failures.ToArray()));
            }
        }
        result["output"] = output.ToString(); result["truncated"] = truncated; Console.WriteLine(serializer.Serialize(result)); return result.ContainsKey("error") ? 1 : 0;
    }
}
