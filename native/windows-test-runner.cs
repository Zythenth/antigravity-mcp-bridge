using System;
using System.Collections.Generic;
using System.ComponentModel;
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
    public sealed class Request
    {
        public string nonce;
        public string cwd;
        public string runtime;
        public string executable;
        public string[] args;
        public int timeoutSeconds;
        public Dictionary<string, string> environment;
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

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
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
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, IntPtr limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr information, uint size, out uint returned);

    static void Check(bool success, string operation)
    {
        if (!success) { int code = Marshal.GetLastWin32Error(); throw new Win32Exception(code, operation + " (Win32 " + code + "): " + new Win32Exception(code).Message); }
    }
    static void CheckHr(int result, string operation) { if (result < 0) throw new Exception(operation + ": 0x" + result.ToString("x8")); }

    static string OwnedDirectory(string directory, string prefix)
    {
        string full = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        string parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        if (!String.Equals(Path.GetDirectoryName(full), parent, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(full).StartsWith(prefix, StringComparison.Ordinal)) throw new Exception("Directory is not owned temporary storage");
        if (!Directory.Exists(full) || (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new Exception("Directory was replaced or linked");
        return full;
    }

    static void Access(string directory, SecurityIdentifier identity, FileSystemRights rights, bool grant)
    {
        var acl = Directory.GetAccessControl(directory);
        var rule = new FileSystemAccessRule(identity, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow);
        if (grant) acl.AddAccessRule(rule); else acl.RemoveAccessRuleSpecific(rule);
        Directory.SetAccessControl(directory, acl);
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

    static int Main(string[] arguments)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var serializer = new JavaScriptSerializer();
        var result = new Dictionary<string, object>();
        string profile = null, cwd = null, runtime = null;
        SecurityIdentifier identity = null;
        IntPtr sid = IntPtr.Zero, job = IntPtr.Zero, attributes = IntPtr.Zero, capabilityData = IntPtr.Zero, policyData = IntPtr.Zero, handleData = IntPtr.Zero, envData = IntPtr.Zero;
        IntPtr registrySid = IntPtr.Zero, capabilityList = IntPtr.Zero;
        IntPtr read = IntPtr.Zero, write = IntPtr.Zero, inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo(); bool attributesInitialized = false, cwdGranted = false, runtimeGranted = false, profileCreated = false;
        var output = new StringBuilder(); bool truncated = false; Thread reader = null;
        object jobGate = new object(); int cancellation = 0;
        try
        {
            if (arguments.Length != 1) throw new Exception("One controller request file is required");
            var request = serializer.Deserialize<Request>(File.ReadAllText(arguments[0], Encoding.UTF8));
            Guid nonce; if (!Guid.TryParseExact(request.nonce, "D", out nonce)) throw new Exception("Invalid nonce");
            result["nonce"] = request.nonce;
            if (request.timeoutSeconds < 1 || request.timeoutSeconds > 86400 || request.args == null || request.environment == null) throw new Exception("Invalid request");
            if (request.args.Length > 50) throw new Exception("Too many command arguments");
            foreach (string argument in request.args) if (argument == null || argument.Length > 4000 || argument.IndexOf('\0') >= 0) throw new Exception("Invalid command argument");
            cwd = OwnedDirectory(request.cwd, "agy-mcp-copy-"); runtime = OwnedDirectory(request.runtime, "agy-mcp-runtime-");
            string executable = Path.GetFullPath(request.executable);
            if (!executable.StartsWith(runtime + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(executable) || (File.GetAttributes(executable) & FileAttributes.ReparsePoint) != 0) throw new Exception("Executable must be staged inside the runtime");
            profile = "agy.test." + Guid.NewGuid().ToString("N");
            CheckHr(CreateAppContainerProfile(profile, profile, "Isolated test process", IntPtr.Zero, 0, out sid), "CreateAppContainerProfile");
            profileCreated = true;
            identity = new SecurityIdentifier(sid);
            Access(cwd, identity, FileSystemRights.Modify | FileSystemRights.Synchronize, true); cwdGranted = true;
            Access(runtime, identity, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, true); runtimeGranted = true;

            var inheritable = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), inherit = 1 };
            Check(CreatePipe(out read, out write, ref inheritable, 0), "Create output pipe");
            Check(SetHandleInformation(read, 1, 0), "Protect output reader");
            Check(CreatePipe(out inputRead, out inputWrite, ref inheritable, 0), "Create input pipe");
            CloseHandle(inputWrite); inputWrite = IntPtr.Zero;
            IntPtr groups, derived; uint groupCount, capabilityCount;
            Check(DeriveCapabilitySidsFromName("registryRead", out groups, out groupCount, out derived, out capabilityCount), "Derive registry metadata capability");
            try
            {
                if (capabilityCount != 1) throw new Exception("Unexpected registry capability count");
                registrySid = Marshal.ReadIntPtr(derived);
            }
            finally
            {
                for (int i = 0; i < groupCount; i++) LocalFree(Marshal.ReadIntPtr(groups, i * IntPtr.Size));
                LocalFree(groups); LocalFree(derived);
            }
            var registryCapability = new SidAndAttributes { sid = registrySid, attributes = 4 };
            capabilityList = Marshal.AllocHGlobal(Marshal.SizeOf(registryCapability)); Marshal.StructureToPtr(registryCapability, capabilityList, false);
            var caps = new SecurityCapabilities { sid = sid, capabilities = capabilityList, count = 1 };
            capabilityData = Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps, capabilityData, false);
            policyData = Marshal.AllocHGlobal(4); Marshal.WriteInt32(policyData, 1);
            handleData = Marshal.AllocHGlobal(IntPtr.Size * 2); Marshal.WriteIntPtr(handleData, write); Marshal.WriteIntPtr(handleData, IntPtr.Size, inputRead);
            UIntPtr size = UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 3, 0, ref size);
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Check(InitializeProcThreadAttributeList(attributes, 3, 0, ref size), "Initialize attributes"); attributesInitialized = true;
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20009), capabilityData, new UIntPtr((uint)Marshal.SizeOf(caps)), IntPtr.Zero, IntPtr.Zero), "Set AppContainer");
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000f), policyData, new UIntPtr(4), IntPtr.Zero, IntPtr.Zero), "Require LPAC");
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleData, new UIntPtr((uint)(IntPtr.Size * 2)), IntPtr.Zero, IntPtr.Zero), "Restrict inherited handles");
            var startup = new StartupInfoEx(); startup.startup.cb = Marshal.SizeOf(startup); startup.startup.flags = 0x100;
            startup.startup.input = inputRead; startup.startup.output = write; startup.startup.error = write; startup.attributes = attributes;
            var command = new StringBuilder(Quote(executable)); foreach (string argument in request.args) command.Append(' ').Append(Quote(argument));
            var environment = new StringBuilder(); var keys = new List<string>(request.environment.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string key in keys)
            {
                string value = request.environment[key];
                if (key.IndexOfAny(new char[] { '=', '\0' }) >= 0 || value.IndexOf('\0') >= 0) throw new Exception("Invalid environment");
                environment.Append(key).Append('=').Append(value).Append('\0');
            }
            environment.Append('\0'); envData = Marshal.StringToHGlobalUni(environment.ToString());
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "Create job");
            var limits = new ExtendedLimits(); limits.basic.flags = 0x2000;
            IntPtr limitData = Marshal.AllocHGlobal(Marshal.SizeOf(limits));
            try { Marshal.StructureToPtr(limits, limitData, false); Check(SetInformationJobObject(job, 9, limitData, (uint)Marshal.SizeOf(limits)), "Require job cleanup"); }
            finally { Marshal.FreeHGlobal(limitData); }
            Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | 0x4 | 0x8000000, envData, cwd, ref startup, out child), "Create isolated process");
            Check(AssignProcessToJobObject(job, child.process), "Assign suspended process to job");
            IntPtr token; Check(OpenProcessToken(child.process, 8, out token), "Inspect child token");
            try
            {
                IntPtr info = Marshal.AllocHGlobal(IntPtr.Size); uint returned;
                try
                {
                    Check(GetTokenInformation(token, 29, info, (uint)IntPtr.Size, out returned), "Verify AppContainer token");
                    if (Marshal.ReadInt32(info) != 1) throw new Exception("AppContainer token missing");
                    GetTokenInformation(token, 31, IntPtr.Zero, 0, out returned);
                    if (returned < IntPtr.Size || returned > 65536) throw new Exception("Invalid package identity size");
                    IntPtr packageInfo = Marshal.AllocHGlobal(checked((int)returned));
                    try
                    {
                        Check(GetTokenInformation(token, 31, packageInfo, returned, out returned), "Verify package identity");
                        if (!identity.Equals(new SecurityIdentifier(Marshal.ReadIntPtr(packageInfo)))) throw new Exception("Package identity mismatch");
                    }
                    finally { Marshal.FreeHGlobal(packageInfo); }
                }
                finally { Marshal.FreeHGlobal(info); }
            }
            finally { CloseHandle(token); }
            var cancelReader = new Thread(delegate()
            {
                string message = Console.ReadLine();
                if (message == null || message == "cancel " + request.nonce)
                {
                    Interlocked.Exchange(ref cancellation, 1);
                    lock (jobGate) { if (job != IntPtr.Zero) TerminateJobObject(job, 125); }
                }
            }); cancelReader.IsBackground = true; cancelReader.Start();
            CloseHandle(write); write = IntPtr.Zero; CloseHandle(inputRead); inputRead = IntPtr.Zero;
            IntPtr outputHandle = read; read = IntPtr.Zero;
            reader = new Thread(delegate()
            {
                using (var stream = new FileStream(new SafeFileHandle(outputHandle, true), FileAccess.Read))
                using (var text = new StreamReader(stream, Encoding.UTF8))
                {
                    char[] buffer = new char[2048]; int count;
                    while ((count = text.Read(buffer, 0, buffer.Length)) != 0)
                    {
                        output.Append(buffer, 0, count);
                        if (output.Length > 4000) { truncated = true; output.Remove(0, output.Length - 4000); }
                    }
                }
            }); reader.Start();
            if (ResumeThread(child.thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "Resume isolated process");
            result["pid"] = child.pid; result["sandbox"] = "windows-lpac";
            uint wait = WaitForSingleObject(child.process, checked((uint)request.timeoutSeconds * 1000));
            if (wait == 0x102)
            {
                result["error"] = "Command timed out"; Check(TerminateJobObject(job, 124), "Terminate timed out job");
                if (WaitForSingleObject(child.process, 5000) != 0) throw new Exception("Timed out process did not terminate");
            }
            else if (wait != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for isolated process");
            uint exit; Check(GetExitCodeProcess(child.process, out exit), "Read exit code"); result["exitCode"] = exit;
            if (Interlocked.CompareExchange(ref cancellation, 0, 0) != 0) result["error"] = "Command cancelled";
        }
        catch (Exception error) { result["error"] = error.Message; result["exitCode"] = null; }
        finally
        {
            if (child.process != IntPtr.Zero) TerminateProcess(child.process, 125);
            lock (jobGate) { if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } }
            if (write != IntPtr.Zero) CloseHandle(write);
            if (reader != null && !reader.Join(5000)) { result["error"] = "Output reader did not terminate"; }
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (child.process != IntPtr.Zero) CloseHandle(child.process);
            if (read != IntPtr.Zero) CloseHandle(read);
            if (inputRead != IntPtr.Zero) CloseHandle(inputRead);
            if (inputWrite != IntPtr.Zero) CloseHandle(inputWrite);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            foreach (IntPtr pointer in new IntPtr[] { attributes, capabilityData, capabilityList, policyData, handleData, envData }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
            if (registrySid != IntPtr.Zero) LocalFree(registrySid);
            try
            {
                if (runtimeGranted) Access(runtime, identity, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, false);
                if (cwdGranted) Access(cwd, identity, FileSystemRights.Modify | FileSystemRights.Synchronize, false);
                if (profileCreated) { CheckHr(DeleteAppContainerProfile(profile), "Delete AppContainer profile"); result["profileDeleted"] = true; }
            }
            catch (Exception error) { result["error"] = "Cleanup failed: " + error.Message; }
            if (sid != IntPtr.Zero) FreeSid(sid);
        }
        result["output"] = output.ToString(); result["truncated"] = truncated;
        Console.WriteLine(serializer.Serialize(result)); return result.ContainsKey("error") ? 1 : 0;
    }
}
