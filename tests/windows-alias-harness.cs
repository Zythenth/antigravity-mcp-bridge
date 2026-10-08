using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;

public static class AliasHarness
{
    const uint RawTargetPath = 0x00000001;
    const uint RemoveDefinition = 0x00000002;
    const uint ExactMatchOnRemove = 0x00000004;
    const uint NoBroadcast = 0x00000008;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DefineDosDevice(uint flags, string name, string target);
    [DllImport("secur32.dll")] static extern int LsaEnumerateLogonSessions(out uint count, out IntPtr sessions);
    [DllImport("secur32.dll")] static extern int LsaFreeReturnBuffer(IntPtr buffer);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);

    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint low; public int high; }

    static Assembly runner;
    static Type program;

    static void Check(bool value, string message)
    {
        if (!value) throw new Exception(message + ": " + Marshal.GetLastWin32Error().ToString());
    }

    static object Invoke(string name, params object[] arguments)
    {
        MethodInfo method = program.GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic);
        if (method == null) throw new Exception("Runner method was not found: " + name);
        try { return method.Invoke(null, arguments); }
        catch (TargetInvocationException error) { throw error.InnerException ?? error; }
    }

    static string[] Targets(string name) { return (string[])Invoke("QueryDosTargets", name); }

    static void RequireAbsent(string name)
    {
        if (Targets(name) != null) throw new Exception("Expected no DOS mapping: " + name);
    }

    static string Raw(string target) { return "\\??\\" + target; }

    static void Define(string name, string target)
    {
        RequireAbsent(name);
        Check(DefineDosDevice(RawTargetPath | NoBroadcast, name, target), "Define DOS device " + name);
        string[] actual = Targets(name);
        if (actual == null || actual.Length != 1 || actual[0] != target) throw new Exception("DOS mapping was not defined exactly: " + name);
    }

    static void Remove(string name, string target)
    {
        Check(DefineDosDevice(RawTargetPath | NoBroadcast | RemoveDefinition | ExactMatchOnRemove, name, target), "Remove DOS device " + name);
        RequireAbsent(name);
    }

    static object New(Type type)
    {
        object value = Activator.CreateInstance(type);
        if (value == null) throw new Exception("Could not create " + type.FullName);
        return value;
    }

    static void Set(object value, string field, object fieldValue)
    {
        FieldInfo info = value.GetType().GetField(field, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (info == null) throw new Exception("Runner field was not found: " + field);
        info.SetValue(value, fieldValue);
    }

    static object Get(object value, string field)
    {
        FieldInfo info = value.GetType().GetField(field, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (info == null) throw new Exception("Runner field was not found: " + field);
        return info.GetValue(value);
    }

    static void ForeignAndStacked()
    {
        string directory = Path.Combine(Path.GetTempPath(), "agy-mcp-alias-harness-" + Guid.NewGuid().ToString("N"));
        string other = Path.Combine(Path.GetTempPath(), "agy-mcp-alias-harness-" + Guid.NewGuid().ToString("N"));
        string nonce = Guid.NewGuid().ToString("N").ToUpperInvariant();
        string foreign = "AGY.TEST.HARNESS." + nonce + ".FOREIGN";
        string stacked = "AGY.TEST.HARNESS." + nonce + ".STACKED";
        string first = Raw(directory), second = Raw(other);
        Directory.CreateDirectory(directory); Directory.CreateDirectory(other);
        try
        {
            Define(foreign, first);
            Type aliasType = runner.GetType("WindowsTestRunner+AliasPlan", true);
            object foreignAlias = New(aliasType); Set(foreignAlias, "customName", foreign); Set(foreignAlias, "customTarget", second);
            bool rejected = false;
            try { Invoke("RemoveAlias", foreignAlias, false); } catch { rejected = true; }
            if (!rejected) throw new Exception("Foreign mapping was unexpectedly removed");
            string[] preserved = Targets(foreign);
            if (preserved == null || preserved.Length != 1 || preserved[0] != first) throw new Exception("Foreign mapping changed during cleanup");
            Remove(foreign, first);

            Define(stacked, first);
            Check(DefineDosDevice(RawTargetPath | NoBroadcast, stacked, second), "Stack DOS device " + stacked);
            string[] initial = Targets(stacked);
            if (initial == null || initial.Length != 2) throw new Exception("Stacked mapping was not created");
            object stackedAlias = New(aliasType); Set(stackedAlias, "customName", stacked); Set(stackedAlias, "customTarget", first);
            rejected = false;
            try { Invoke("RemoveAlias", stackedAlias, false); } catch { rejected = true; }
            if (!rejected) throw new Exception("Stacked mapping was unexpectedly removed");
            string[] retained = Targets(stacked);
            if (retained == null || retained.Length != 2) throw new Exception("Stacked mapping changed during cleanup");
            Check(DefineDosDevice(RawTargetPath | NoBroadcast | RemoveDefinition | ExactMatchOnRemove, stacked, second), "Remove stacked second target");
            Remove(stacked, first);
        }
        finally
        {
            if (Targets(foreign) != null) Remove(foreign, first);
            string[] values = Targets(stacked);
            if (values != null)
            {
                for (int index = values.Length - 1; index >= 0; index--) Check(DefineDosDevice(RawTargetPath | NoBroadcast | RemoveDefinition | ExactMatchOnRemove, stacked, values[index]), "Remove retained stacked target");
                RequireAbsent(stacked);
            }
            Directory.Delete(directory); Directory.Delete(other);
        }
    }

    static void InsufficientLetters()
    {
        string target = Path.Combine(Path.GetTempPath(), "agy-mcp-alias-harness-" + Guid.NewGuid().ToString("N"));
        var allocated = new List<string>(); var pins = new List<IDisposable>();
        Directory.CreateDirectory(target);
        try
        {
            string raw = Raw(target);
            for (char letter = 'D'; letter <= 'Z'; letter++)
            {
                string drive = letter + ":";
                if (Targets(drive) == null) { Define(drive, raw); allocated.Add(drive); }
            }
            object controller = Invoke("CurrentControllerIdentity");
            Type grantType = runner.GetType("WindowsTestRunner+Grant", true), pinnedType = runner.GetType("WindowsTestRunner+PinnedTarget", true);
            Array roots = Array.CreateInstance(pinnedType, 3);
            for (int index = 0; index < roots.Length; index++)
            {
                object grant = New(grantType); Set(grant, "path", target); Set(grant, "rights", "read");
                object pin = Invoke("PinGrant", grant, 100);
                roots.SetValue(pin, index); pins.Add((IDisposable)pin);
            }
            bool rejected = false;
            try { Invoke("CreateAliasPlan", Guid.NewGuid(), controller, roots); }
            catch (Exception error) { rejected = error.Message.IndexOf("Fewer than three unused DOS drive letters", StringComparison.Ordinal) >= 0; }
            if (!rejected) throw new Exception("Alias planning succeeded without three free letters");
        }
        finally
        {
            for (int index = pins.Count - 1; index >= 0; index--) pins[index].Dispose();
            for (int index = allocated.Count - 1; index >= 0; index--) Remove(allocated[index], Raw(target));
            Directory.Delete(target);
        }
    }

    static void AbandonedMutex()
    {
        object controller = Invoke("CurrentControllerIdentity");
        string logon = (string)Get(controller, "logon");
        const char letter = 'Z'; string name = "Global\\AGY.TEST.DOS." + logon + "." + letter;
        bool created = false;
        var owner = new Thread(new ThreadStart(delegate { new Mutex(true, name, out created); }));
        owner.Start(); owner.Join();
        if (!created) throw new Exception("Abandoned mutex name was unexpectedly occupied");
        Mutex recovered = (Mutex)Invoke("AcquireRecoveryDriveGate", letter, controller, logon);
        try { if (recovered == null) throw new Exception("Abandoned mutex was not recovered"); }
        finally { if (recovered != null) { recovered.ReleaseMutex(); recovered.Close(); } }
    }

    static string LogonName(Luid value) { return ((uint)value.high).ToString("x8") + "." + value.low.ToString("x8"); }

    static List<string> ExistingLogons()
    {
        uint count; IntPtr sessions; int status = LsaEnumerateLogonSessions(out count, out sessions);
        if (status != 0) throw new Exception("Harness could not enumerate logon sessions: 0x" + status.ToString("x8"));
        try
        {
            if (count > 1048576) throw new Exception("Harness logon session enumeration exceeded its bounded count");
            int size = Marshal.SizeOf(typeof(Luid)); var logons = new List<string>();
            for (uint index = 0; index < count; index++) logons.Add(LogonName((Luid)Marshal.PtrToStructure(IntPtr.Add(sessions, checked((int)(index * (uint)size))), typeof(Luid))));
            return logons;
        }
        finally
        {
            if (sessions != IntPtr.Zero)
            {
                int released = LsaFreeReturnBuffer(sessions);
                if (released != 0) throw new Exception("Harness could not free logon sessions: 0x" + released.ToString("x8"));
            }
        }
    }

    static string MissingLogon()
    {
        var existing = new HashSet<string>(ExistingLogons(), StringComparer.OrdinalIgnoreCase);
        for (uint low = UInt32.MaxValue; low > UInt32.MaxValue - 1024; low--)
        {
            string candidate = "ffffffff." + low.ToString("x8");
            if (!existing.Contains(candidate)) return candidate;
        }
        throw new Exception("Could not select an absent logon identifier");
    }

    sealed class LeaseFixture : IDisposable
    {
        public readonly string state, copy, runtime, scratch, nonce, file;
        public readonly string[] drives = new string[3], names = new string[3], targets = new string[3];
        readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        string sid;

        public LeaseFixture(string state)
        {
            this.state = state; nonce = Guid.NewGuid().ToString("D");
            copy = NewTemporary("agy-mcp-copy-"); runtime = NewTemporary("agy-mcp-runtime-"); scratch = NewTemporary("agy-mcp-scratch-");
            var available = new List<string>();
            for (char letter = 'Z'; letter >= 'D' && available.Count < 3; letter--)
            {
                string drive = letter + ":";
                if (Targets(drive) == null) available.Add(drive);
            }
            if (available.Count != 3) throw new Exception("Harness needs three unused DOS drive letters");
            string[] kinds = new string[] { "COPY", "RUNTIME", "SCRATCH" }, roots = new string[] { copy, runtime, scratch };
            for (int index = 0; index < 3; index++)
            {
                drives[index] = available[index]; names[index] = "AGY.TEST." + nonce.ToUpperInvariant() + "." + kinds[index];
                targets[index] = Raw(roots[index]);
            }
            Directory.CreateDirectory(Path.Combine(state, "windows-lpac-leases")); file = Path.Combine(state, "windows-lpac-leases", nonce.Replace("-", "") + ".json");
        }

        static string NewTemporary(string prefix)
        {
            string directory = Path.Combine(Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory); return directory;
        }

        public void Write(int version, string phase, string logon, int pid, long started)
        {
            var lease = new Dictionary<string, object> {
                { "version", version }, { "nonce", nonce }, { "profile", "agy.test." + nonce.Replace("-", "") }, { "phase", phase },
                { "controllerPid", pid }, { "controllerStarted", started }, { "cwd", copy }, { "runtime", runtime }, { "scratch", scratch }, { "grants", new object[0] },
            };
            if (phase != "creating")
            {
                if (String.IsNullOrEmpty(sid)) throw new Exception("Non-creating harness lease needs a profile SID");
                lease.Add("sid", sid);
            }
            if (version == 2)
            {
                var aliases = new List<Dictionary<string, object>>();
                string[] kinds = new string[] { "copy", "runtime", "scratch" }, roots = new string[] { copy, runtime, scratch };
                for (int index = 0; index < 3; index++) aliases.Add(new Dictionary<string, object> {
                    { "kind", kinds[index] }, { "physicalRoot", roots[index] }, { "customName", names[index] }, { "drive", drives[index] }, { "aliasRoot", drives[index] + "\\" }, { "customTarget", targets[index] }, { "driveTarget", Raw(names[index]) },
                });
                lease.Add("logon", logon); lease.Add("aliases", aliases);
            }
            byte[] data = new System.Text.UTF8Encoding(false).GetBytes(serializer.Serialize(lease));
            using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(data, 0, data.Length); stream.Flush(true); }
        }

        public void DefinePartial()
        {
            Define(names[0], targets[0]); Define(names[1], targets[1]); Define(drives[1], Raw(names[1]));
        }

        public void DefineForeignDrive(string target) { Define(drives[0], Raw(target)); }

        public void CreateProfile()
        {
            IntPtr identity; int result = CreateAppContainerProfile("agy.test." + nonce.Replace("-", ""), "alias harness", "alias harness", IntPtr.Zero, 0, out identity);
            if (result < 0 || identity == IntPtr.Zero) throw new Exception("Harness profile creation failed: 0x" + result.ToString("x8"));
            try { sid = new SecurityIdentifier(identity).Value; }
            finally { FreeSid(identity); }
        }

        public void AssertRemoved()
        {
            for (int index = 0; index < 3; index++) { RequireAbsent(names[index]); RequireAbsent(drives[index]); }
        }

        public void Dispose()
        {
            for (int index = 2; index >= 0; index--)
            {
                string[] drive = Targets(drives[index]); if (drive != null && drive.Length == 1 && drive[0] == Raw(names[index])) Remove(drives[index], Raw(names[index]));
                string[] custom = Targets(names[index]); if (custom != null && custom.Length == 1 && custom[0] == targets[index]) Remove(names[index], targets[index]);
            }
            if (File.Exists(file)) File.Delete(file);
            if (!String.IsNullOrEmpty(sid)) DeleteAppContainerProfile("agy.test." + nonce.Replace("-", ""));
            Directory.Delete(copy); Directory.Delete(runtime); Directory.Delete(scratch);
        }
    }

    static Dictionary<string, object> RecoverState(string state)
    {
        var result = new Dictionary<string, object>(); Invoke("Recover", state, result, new JavaScriptSerializer()); return result;
    }

    static void RecoveryLuid()
    {
        object controller = Invoke("CurrentControllerIdentity");
        string current = (string)Get(controller, "logon"), existing = null;
        foreach (string candidate in ExistingLogons()) if (!String.Equals(candidate, current, StringComparison.OrdinalIgnoreCase)) { existing = candidate; break; }
        if (existing == null) throw new Exception("Harness needs an existing non-controller logon session");

        string retainedState = Path.Combine(Path.GetTempPath(), "agy-mcp-alias-state-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(retainedState);
        var retained = new LeaseFixture(retainedState);
        try
        {
            retained.Write(2, "creating", existing, Process.GetCurrentProcess().Id, 1);
            Dictionary<string, object> result = RecoverState(retainedState);
            if (!result.ContainsKey("error") || !File.Exists(retained.file) || File.ReadAllText(retained.file).IndexOf("cleanup-failed", StringComparison.Ordinal) < 0) throw new Exception("Existing logon session did not retain its alias lease");
        }
        finally { retained.Dispose(); Directory.Delete(retainedState, true); }

        string state = Path.Combine(Path.GetTempPath(), "agy-mcp-alias-state-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(state);
        string absentLogon = MissingLogon(), foreign = Path.Combine(Path.GetTempPath(), "agy-mcp-alias-harness-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(foreign);
        try
        {
            var planned = new LeaseFixture(state);
            try
            {
                planned.Write(2, "creating", current, Process.GetCurrentProcess().Id, 1);
                Dictionary<string, object> result = RecoverState(state);
                if (result.ContainsKey("error") || Convert.ToInt32(result["recovered"]) != 1 || File.Exists(planned.file)) throw new Exception("Planned alias lease was not recovered");
                planned.AssertRemoved(); if (!Directory.Exists(planned.copy)) throw new Exception("Recovery removed a retained copy");
            }
            finally { planned.Dispose(); }

            var partial = new LeaseFixture(state);
            try
            {
                partial.CreateProfile(); partial.Write(2, "cleanup-failed", current, Process.GetCurrentProcess().Id, 1); partial.DefinePartial();
                Dictionary<string, object> result = RecoverState(state);
                if (result.ContainsKey("error") || Convert.ToInt32(result["recovered"]) != 1 || File.Exists(partial.file)) throw new Exception("Partial alias lease was not recovered");
                partial.AssertRemoved(); if (!Directory.Exists(partial.copy)) throw new Exception("Recovery removed a retained partial copy");
            }
            finally { partial.Dispose(); }

            var absent = new LeaseFixture(state);
            try
            {
                absent.Write(2, "creating", absentLogon, Process.GetCurrentProcess().Id, 1); absent.DefineForeignDrive(foreign);
                Dictionary<string, object> result = RecoverState(state);
                if (result.ContainsKey("error") || Convert.ToInt32(result["recovered"]) != 1 || File.Exists(absent.file)) throw new Exception("Absent-LUID lease was not recovered");
                string[] preserved = Targets(absent.drives[0]); if (preserved == null || preserved.Length != 1 || preserved[0] != Raw(foreign)) throw new Exception("Absent-LUID recovery changed a current-session drive mapping");
                if (!Directory.Exists(absent.copy)) throw new Exception("Recovery removed an absent-LUID retained copy");
                Remove(absent.drives[0], Raw(foreign));
            }
            finally
            {
                string[] mapped = Targets(absent.drives[0]); if (mapped != null && mapped.Length == 1 && mapped[0] == Raw(foreign)) Remove(absent.drives[0], Raw(foreign));
                absent.Dispose();
            }

            var legacy = new LeaseFixture(state);
            try
            {
                legacy.Write(1, "creating", null, Process.GetCurrentProcess().Id, 1);
                Dictionary<string, object> result = RecoverState(state);
                if (result.ContainsKey("error") || Convert.ToInt32(result["recovered"]) != 1 || File.Exists(legacy.file)) throw new Exception("Legacy v1 lease was not recovered");
            }
            finally { legacy.Dispose(); }

            var active = new LeaseFixture(state);
            try
            {
                active.Write(2, "creating", current, Process.GetCurrentProcess().Id, (long)Invoke("CurrentProcessStart"));
                Dictionary<string, object> result = RecoverState(state);
                if (result.ContainsKey("error") || Convert.ToInt32(result["active"]) != 1 || !File.Exists(active.file)) throw new Exception("Live lease was not retained");
            }
            finally { active.Dispose(); }
        }
        finally
        {
            Directory.Delete(foreign); Directory.Delete(state, true);
        }
    }

    public static int Main(string[] arguments)
    {
        if (arguments.Length < 2) throw new ArgumentException("Expected runner path and action");
        runner = Assembly.LoadFrom(arguments[0]); program = runner.GetType("WindowsTestRunner", true);
        if (arguments[1] == "query" && arguments.Length == 3) { Console.WriteLine(Targets(arguments[2]) == null ? "ABSENT" : "PRESENT"); return 0; }
        if (arguments[1] == "foreign-stacked") { ForeignAndStacked(); return 0; }
        if (arguments[1] == "insufficient") { InsufficientLetters(); return 0; }
        if (arguments[1] == "abandoned") { AbandonedMutex(); return 0; }
        if (arguments[1] == "recovery-luid") { RecoveryLuid(); return 0; }
        throw new ArgumentException("Unknown alias harness action");
    }
}
