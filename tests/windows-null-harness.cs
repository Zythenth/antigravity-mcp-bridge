using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;

internal static class WindowsNullHarness
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateMutex(IntPtr lpMutexAttributes, bool bInitialOwner, string lpName);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint sharing, IntPtr attrs, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);

    static readonly SecurityIdentifier SidsRestrictedPackages = new SecurityIdentifier("S-1-15-2-2");
    static readonly SecurityIdentifier SidsWorld = new SecurityIdentifier("S-1-1-0");
    static readonly SecurityIdentifier SidsTestA = new SecurityIdentifier("S-1-15-2-1000-2000-3000-4001");
    static readonly SecurityIdentifier SidsTestB = new SecurityIdentifier("S-1-15-2-1000-2000-3000-4002");

    static RawSecurityDescriptor CreateStockCiDacl(bool includeRestrictedPackages, bool includeDeny)
    {
        // Stock Windows CI DACL: D:(A;;0x1201bf;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;RC)
        var acl = new RawAcl(RawAcl.AclRevision, 8);
        if (includeDeny)
        {
            acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessDenied, 0x12019f, SidsRestrictedPackages, false, null));
        }
        acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x1201bf, SidsWorld, false, null));
        acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000, new SecurityIdentifier("S-1-5-18"), false, null)); // LocalSystem FA
        acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000, new SecurityIdentifier("S-1-5-32-544"), false, null)); // Administrators FA
        acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x1200a9, new SecurityIdentifier("S-1-5-12"), false, null)); // Restricted Code RC
        if (includeRestrictedPackages)
        {
            acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x1201bf, SidsRestrictedPackages, false, null));
        }
        var sd = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent, new SecurityIdentifier("S-1-5-18"), new SecurityIdentifier("S-1-5-18"), null, acl);
        return sd;
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateNamedPipe(string name,uint mode,uint type,uint instances,uint output,uint input,uint timeout,IntPtr attrs);
    static IntPtr CreatePrivateFileObject()
    {
        IntPtr handle=CreateNamedPipe(@"\\.\pipe\LOCAL\AGY.TEST.NULL.CONTROL."+Guid.NewGuid().ToString("N"),0x40003,0,1,512,512,1000,IntPtr.Zero);
        if(handle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"Create private pipe control");
        return handle;
    }

    static RawSecurityDescriptor CloneDescriptor(RawSecurityDescriptor source)
    {
        byte[] data = new byte[source.BinaryLength];
        source.GetBinaryForm(data, 0);
        return new RawSecurityDescriptor(data, 0);
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--job-child") { Thread.Sleep(60000); return 0; }
            if (args.Length < 2)
            {
                Console.Error.WriteLine("Usage: WindowsNullHarness <runnerDllPath> <testName>");
                return 1;
            }

            string assemblyPath = args[0];
            string testName = args[1];

            Assembly runnerAssembly = Assembly.LoadFrom(assemblyPath);
            Type runnerType = runnerAssembly.GetType("WindowsTestRunner", true);

            MethodInfo isStockSufficient = runnerType.GetMethod("IsStockNullAccessSufficient", BindingFlags.Static | BindingFlags.NonPublic);
            MethodInfo applyAce = runnerType.GetMethod("ApplyNullDeviceAceToDescriptor", BindingFlags.Static | BindingFlags.NonPublic);
            MethodInfo removeAce = runnerType.GetMethod("RemoveNullDeviceAceFromDescriptor", BindingFlags.Static | BindingFlags.NonPublic);
            MethodInfo verifyPreservation = runnerType.GetMethod("VerifyDaclPreservation", BindingFlags.Static | BindingFlags.NonPublic);
            MethodInfo applyKernelGrant = runnerType.GetMethod("ApplyKernelObjectGrant", BindingFlags.Static | BindingFlags.NonPublic);
            MethodInfo removeKernelGrant = runnerType.GetMethod("RemoveKernelObjectGrant", BindingFlags.Static | BindingFlags.NonPublic);
            Type gateType = runnerType.GetNestedType("NullDeviceGate", BindingFlags.NonPublic);
            MethodInfo gateAcquire = gateType.GetMethod("Acquire", BindingFlags.Static | BindingFlags.Public, null, new Type[] { typeof(int) }, null);

            switch (testName)
            {
                case "test-no-op-stock-acl":
                {
                    // Synthetic test: stock DACL with S-1-15-2-2 already present with 0x1201bf
                    RawSecurityDescriptor sdWithPackage = CreateStockCiDacl(true, false);
                    bool sufficient = (bool)isStockSufficient.Invoke(null, new object[] { sdWithPackage, SidsTestA });
                    if (!sufficient) throw new Exception("Expected stock S-1-15-2-2 access to be reported sufficient");

                    // Also test with exact rights 0x12019f
                    var aclExact = new RawAcl(RawAcl.AclRevision, 2);
                    aclExact.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x12019f, SidsRestrictedPackages, false, null));
                    var sdExact = new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent, null, null, null, aclExact);
                    if (!(bool)isStockSufficient.Invoke(null, new object[] { sdExact, SidsTestA }))
                        throw new Exception("Expected exact 0x12019f S-1-15-2-2 access to be sufficient");

                    Console.WriteLine("pass:no-op-stock-acl");
                    return 0;
                }

                case "test-missing-stock-acl":
                {
                    // Synthetic test: stock CI DACL lacking S-1-15-2-2
                    RawSecurityDescriptor sdMissing = CreateStockCiDacl(false, false);
                    bool sufficient = (bool)isStockSufficient.Invoke(null, new object[] { sdMissing, SidsTestA });
                    if (sufficient) throw new Exception("Expected stock CI DACL without package ACE to be reported insufficient");

                    Console.WriteLine("pass:missing-stock-acl");
                    return 0;
                }

                case "test-least-rights":
                {
                    // Synthetic test: verify added ACE has exact 0x12019f and no excess rights
                    RawSecurityDescriptor sd = CreateStockCiDacl(false, false);
                    applyAce.Invoke(null, new object[] { sd, SidsTestA });

                    CommonAce added = null;
                    foreach (GenericAce candidate in sd.DiscretionaryAcl)
                    {
                        var common = candidate as CommonAce;
                        if (common != null && common.SecurityIdentifier.Equals(SidsTestA))
                        {
                            added = common;
                            break;
                        }
                    }

                    if (added == null) throw new Exception("Added ACE was not found in DACL");
                    if (added.AceQualifier != AceQualifier.AccessAllowed) throw new Exception("Added ACE must be AccessAllowed");
                    if (added.AceFlags != AceFlags.None) throw new Exception("Added ACE must have no inherit flags (AceFlags.None)");
                    if (added.IsCallback) throw new Exception("Added ACE must not be a callback ACE");

                    const int expectedMask = 0x12019f;
                    if (added.AccessMask != expectedMask)
                        throw new Exception("Added ACE mask must be exactly 0x" + expectedMask.ToString("x8") + ", got 0x" + added.AccessMask.ToString("x8"));

                    // Verify absence of sensitive bits
                    if ((added.AccessMask & 0x00010000) != 0) throw new Exception("Added ACE must not grant DELETE (0x10000)");
                    if ((added.AccessMask & 0x00000020) != 0) throw new Exception("Added ACE must not grant FILE_EXECUTE (0x20)");
                    if ((added.AccessMask & 0x00040000) != 0) throw new Exception("Added ACE must not grant WRITE_DAC (0x40000)");
                    if ((added.AccessMask & 0x00080000) != 0) throw new Exception("Added ACE must not grant WRITE_OWNER (0x80000)");

                    // Verify presence of required read and write bits
                    if ((added.AccessMask & 0x00000001) == 0) throw new Exception("Added ACE must grant FILE_READ_DATA (0x1)");
                    if ((added.AccessMask & 0x00000002) == 0) throw new Exception("Added ACE must grant FILE_WRITE_DATA (0x2)");
                    if ((added.AccessMask & 0x00000080) == 0) throw new Exception("Added ACE must grant FILE_READ_ATTRIBUTES (0x80)");
                    if ((added.AccessMask & 0x00000100) == 0) throw new Exception("Added ACE must grant FILE_WRITE_ATTRIBUTES (0x100)");
                    if ((added.AccessMask & 0x00100000) == 0) throw new Exception("Added ACE must grant SYNCHRONIZE (0x100000)");
                    if ((added.AccessMask & 0x00020000) == 0) throw new Exception("Added ACE must grant READ_CONTROL (0x20000)");

                    Console.WriteLine("pass:least-rights");
                    return 0;
                }

                case "test-foreign-and-deny-preservation":
                {
                    // Synthetic test: foreign ACE preservation and explicit deny rejection
                    RawSecurityDescriptor original = CreateStockCiDacl(false, false);
                    byte[] cloneBytes = new byte[original.BinaryLength];
                    original.GetBinaryForm(cloneBytes, 0);
                    RawSecurityDescriptor copy = new RawSecurityDescriptor(cloneBytes, 0);

                    applyAce.Invoke(null, new object[] { copy, SidsTestA });
                    verifyPreservation.Invoke(null, new object[] { original, copy, SidsTestA, null });

                    RawSecurityDescriptor beforeRemoval = CloneDescriptor(copy);
                    removeAce.Invoke(null, new object[] { copy, SidsTestA, true });
                    verifyPreservation.Invoke(null, new object[] { beforeRemoval, copy, null, SidsTestA });

                    // Test with explicit deny
                    RawSecurityDescriptor sdDeny = CreateStockCiDacl(false, true);
                    bool denyFailed = false;
                    try
                    {
                        applyAce.Invoke(null, new object[] { sdDeny, SidsTestA });
                    }
                    catch (TargetInvocationException ex)
                    {
                        if (ex.InnerException != null && ex.InnerException.Message.Contains("Explicit deny"))
                            denyFailed = true;
                    }
                    if (!denyFailed) throw new Exception("Expected explicit deny to cause ApplyNullDeviceAceToDescriptor to throw");

                    bool stockSufficientWithDeny = (bool)isStockSufficient.Invoke(null, new object[] { sdDeny, SidsTestA });
                    if (stockSufficientWithDeny) throw new Exception("Expected explicit deny to cause IsStockNullAccessSufficient to return false");

                    var unsupported=CreateStockCiDacl(false,false);
                    unsupported.SetFlags(unsupported.ControlFlags|ControlFlags.DiscretionaryAclAutoInherited);
                    string unsupportedBefore=unsupported.GetSddlForm(AccessControlSections.Access);bool flagsRejected=false;
                    try{applyAce.Invoke(null,new object[]{unsupported,SidsTestA});}catch(TargetInvocationException e){flagsRejected=e.InnerException!=null&&e.InnerException.Message.Contains("Unsupported Null device DACL control flags");}
                    if(!flagsRejected||unsupported.GetSddlForm(AccessControlSections.Access)!=unsupportedBefore)throw new Exception("Unsupported controls must fail before changing the DACL");
                    Console.WriteLine("pass:foreign-and-deny-preservation");
                    return 0;
                }

                case "test-duplicate-and-unexpected-owned-ace":
                {
                    // Synthetic test: reject pre-existing ACE on grant, reject duplicates on cleanup
                    RawSecurityDescriptor sd = CreateStockCiDacl(false, false);
                    applyAce.Invoke(null, new object[] { sd, SidsTestA });

                    bool duplicateGrantFailed = false;
                    try
                    {
                        applyAce.Invoke(null, new object[] { sd, SidsTestA });
                    }
                    catch (TargetInvocationException ex)
                    {
                        if (ex.InnerException != null && ex.InnerException.Message.Contains("Duplicate or unexpected"))
                            duplicateGrantFailed = true;
                    }
                    if (!duplicateGrantFailed) throw new Exception("Expected duplicate grant to fail");

                    // Insert a second ACE manually to simulate a duplicate on cleanup
                    sd.DiscretionaryAcl.InsertAce(sd.DiscretionaryAcl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x12019f, SidsTestA, false, null));
                    bool duplicateCleanupFailed = false;
                    try
                    {
                        removeAce.Invoke(null, new object[] { sd, SidsTestA, true });
                    }
                    catch (TargetInvocationException ex)
                    {
                        if (ex.InnerException != null && ex.InnerException.Message.Contains("Duplicate owned ACEs"))
                            duplicateCleanupFailed = true;
                    }
                    if (!duplicateCleanupFailed) throw new Exception("Expected duplicate cleanup to fail");

                    // Test unexpected mask on cleanup
                    RawSecurityDescriptor sdUnexpectedMask = CreateStockCiDacl(false, false);
                    sdUnexpectedMask.DiscretionaryAcl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x1201bf, SidsTestA, false, null));
                    bool unexpectedMaskFailed = false;
                    try
                    {
                        removeAce.Invoke(null, new object[] { sdUnexpectedMask, SidsTestA, true });
                    }
                    catch (TargetInvocationException ex)
                    {
                        if (ex.InnerException != null && ex.InnerException.Message.Contains("Unexpected owned permission rule"))
                            unexpectedMaskFailed = true;
                    }
                    if (!unexpectedMaskFailed) throw new Exception("Expected unexpected mask on cleanup to fail");

                    Console.WriteLine("pass:duplicate-and-unexpected-owned-ace");
                    return 0;
                }

                case "test-interrupted-pending-grant-and-recovery":
                {
                    // Synthetic test: recovery when grant was pending but never written (no-op)
                    RawSecurityDescriptor sdUnwritten = CreateStockCiDacl(false, false);
                    byte[] beforeBytes = new byte[sdUnwritten.BinaryLength];
                    sdUnwritten.GetBinaryForm(beforeBytes, 0);

                    bool removed = (bool)removeAce.Invoke(null, new object[] { sdUnwritten, SidsTestA, false });
                    if (removed) throw new Exception("Expected unwritten grant recovery to return false (no-op)");
                    byte[] afterBytes = new byte[sdUnwritten.BinaryLength];
                    sdUnwritten.GetBinaryForm(afterBytes, 0);
                    for (int i = 0; i < beforeBytes.Length; i++)
                        if (beforeBytes[i] != afterBytes[i]) throw new Exception("Descriptor changed during harmless no-op recovery");

                    // Synthetic test: recovery when grant was written
                    RawSecurityDescriptor sdWritten = CreateStockCiDacl(false, false);
                    applyAce.Invoke(null, new object[] { sdWritten, SidsTestA });
                    RawSecurityDescriptor beforeWrittenRemoval = CloneDescriptor(sdWritten);
                    bool removedWritten = (bool)removeAce.Invoke(null, new object[] { sdWritten, SidsTestA, false });
                    if (!removedWritten) throw new Exception("Expected written grant recovery to return true");
                    verifyPreservation.Invoke(null, new object[] { beforeWrittenRemoval, sdWritten, null, SidsTestA });

                    Console.WriteLine("pass:interrupted-pending-grant-and-recovery");
                    return 0;
                }

                case "test-distinct-sid-transforms":
                {
                    // Synthetic test: concurrent distinct SIDs A and B
                    RawSecurityDescriptor original = CreateStockCiDacl(false, false);
                    byte[] origBytes = new byte[original.BinaryLength];
                    original.GetBinaryForm(origBytes, 0);
                    RawSecurityDescriptor current = new RawSecurityDescriptor(origBytes, 0);

                    // Add SID A
                    applyAce.Invoke(null, new object[] { current, SidsTestA });
                    // Add SID B
                    applyAce.Invoke(null, new object[] { current, SidsTestB });

                    if (current.DiscretionaryAcl.Count != original.DiscretionaryAcl.Count + 2)
                        throw new Exception("Expected 2 additional ACEs for distinct SIDs");

                    // Remove SID A, verify SID B preserved
                    removeAce.Invoke(null, new object[] { current, SidsTestA, true });
                    bool sidBFound = false;
                    foreach (GenericAce ace in current.DiscretionaryAcl)
                    {
                        var common = ace as CommonAce;
                        if (common != null && common.SecurityIdentifier.Equals(SidsTestB)) sidBFound = true;
                        if (common != null && common.SecurityIdentifier.Equals(SidsTestA))
                            throw new Exception("SID A was not removed");
                    }
                    if (!sidBFound) throw new Exception("SID B was unexpectedly removed");

                    // Remove SID B, verify original restored
                    removeAce.Invoke(null, new object[] { current, SidsTestB, true });
                    if (current.DiscretionaryAcl.Count != original.DiscretionaryAcl.Count)
                        throw new Exception("DACL count did not return to original baseline");

                    Console.WriteLine("pass:distinct-sid-transforms");
                    return 0;
                }

                case "test-concurrent-distinct-sids":
                {
                    IntPtr target=CreatePrivateFileObject();
                    if(target==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
                    MethodInfo readKernel=runnerType.GetMethod("ReadKernelDacl",BindingFlags.Static|BindingFlags.NonPublic);
                    var before=(RawSecurityDescriptor)readKernel.Invoke(null,new object[]{target});
                    var addedA=new ManualResetEvent(false);var addedB=new ManualResetEvent(false);
                    var removeA=new ManualResetEvent(false);var removeB=new ManualResetEvent(false);var removedA=new ManualResetEvent(false);
                    Exception failureA=null,failureB=null;
                    var a=new Thread(delegate(){try{
                        using((IDisposable)gateAcquire.Invoke(null,new object[]{5000}))applyKernelGrant.Invoke(null,new object[]{target,SidsTestA});
                        addedA.Set();if(!removeA.WaitOne(10000))throw new Exception("SID A release timed out");
                        using((IDisposable)gateAcquire.Invoke(null,new object[]{5000}))removeKernelGrant.Invoke(null,new object[]{target,SidsTestA,true});
                        removedA.Set();
                    }catch(Exception e){failureA=e;addedA.Set();removedA.Set();}});a.IsBackground=true;
                    var b=new Thread(delegate(){try{
                        using((IDisposable)gateAcquire.Invoke(null,new object[]{5000}))applyKernelGrant.Invoke(null,new object[]{target,SidsTestB});
                        addedB.Set();if(!removeB.WaitOne(10000))throw new Exception("SID B release timed out");
                        using((IDisposable)gateAcquire.Invoke(null,new object[]{5000}))removeKernelGrant.Invoke(null,new object[]{target,SidsTestB,true});
                    }catch(Exception e){failureB=e;addedB.Set();}});b.IsBackground=true;
                    try{
                        a.Start();b.Start();if(!WaitHandle.WaitAll(new WaitHandle[]{addedA,addedB},10000))throw new Exception("Concurrent grants timed out");
                        if(failureA!=null||failureB!=null)throw new Exception("Concurrent grant failed",failureA??failureB);
                        var both=(RawSecurityDescriptor)readKernel.Invoke(null,new object[]{target});int count=0;
                        foreach(GenericAce entry in both.DiscretionaryAcl){var ace=entry as CommonAce;if(ace!=null&&(ace.SecurityIdentifier.Equals(SidsTestA)||ace.SecurityIdentifier.Equals(SidsTestB)))count++;}
                        if(count!=2)throw new Exception("Concurrent grants lost an owned ACE");
                        removeA.Set();if(!removedA.WaitOne(10000)||failureA!=null)throw new Exception("SID A cleanup failed",failureA);
                        var remaining=(RawSecurityDescriptor)readKernel.Invoke(null,new object[]{target});bool retainedB=false;
                        foreach(GenericAce entry in remaining.DiscretionaryAcl){var ace=entry as CommonAce;if(ace!=null&&ace.SecurityIdentifier.Equals(SidsTestA))throw new Exception("SID A remained");if(ace!=null&&ace.SecurityIdentifier.Equals(SidsTestB))retainedB=true;}
                        if(!retainedB)throw new Exception("Cleaning SID A removed SID B");
                        removeB.Set();if(!a.Join(5000)||!b.Join(5000)||failureB!=null)throw new Exception("Concurrent cleanup failed",failureB);
                        var after=(RawSecurityDescriptor)readKernel.Invoke(null,new object[]{target});
                        if(before.GetSddlForm(AccessControlSections.Access)!=after.GetSddlForm(AccessControlSections.Access))throw new Exception("Concurrent cleanup changed foreign DACL");
                    }finally{removeA.Set();removeB.Set();a.Join(5000);b.Join(5000);CloseHandle(target);addedA.Close();addedB.Close();removeA.Close();removeB.Close();removedA.Close();}
                    Console.WriteLine("pass:concurrent-distinct-sids");return 0;
                }
                case "test-absent-null-grant":
                {
                    IntPtr target=CreateFile(@"\\?\GLOBALROOT\Device\Null",0x20000,3,IntPtr.Zero,3,0,IntPtr.Zero);
                    if(target==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
                    try{
                        MethodInfo readKernel=runnerType.GetMethod("ReadKernelDacl",BindingFlags.Static|BindingFlags.NonPublic);
                        var before=(RawSecurityDescriptor)readKernel.Invoke(null,new object[]{target});
                        foreach(GenericAce entry in before.DiscretionaryAcl){var ace=entry as KnownAce;if(ace!=null&&ace.SecurityIdentifier.Equals(SidsTestA))throw new Exception("Synthetic SID unexpectedly exists on system Null");}
                        runnerType.GetMethod("ReconcileRecoveryNullDeviceGrant",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{SidsTestA});
                        var after=(RawSecurityDescriptor)readKernel.Invoke(null,new object[]{target});
                        if(before.GetSddlForm(AccessControlSections.Access)!=after.GetSddlForm(AccessControlSections.Access))throw new Exception("Absent-grant reconciliation changed Null DACL");
                    }finally{CloseHandle(target);}
                    Console.WriteLine("pass:absent-null-grant");return 0;
                }
                case "test-job-empty-wait":
                {
                    IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
                    Process owned=null,unrelated=null;
                    try{
                        var start=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"--job-child"){UseShellExecute=false,CreateNoWindow=true};
                        owned=Process.Start(start);unrelated=Process.Start(start);
                        if(!AssignProcessToJobObject(job,owned.Handle))throw new Win32Exception(Marshal.GetLastWin32Error());
                        MethodInfo waitEmpty=runnerType.GetMethod("WaitForEmptyJob",BindingFlags.Static|BindingFlags.NonPublic);bool busy=false;
                        try{waitEmpty.Invoke(null,new object[]{job,20});}catch(TargetInvocationException e){busy=e.InnerException!=null&&e.InnerException.Message.Contains("not terminated");}
                        if(!busy)throw new Exception("A live owned job was reported empty");
                        if(!TerminateJobObject(job,125))throw new Win32Exception(Marshal.GetLastWin32Error());
                        waitEmpty.Invoke(null,new object[]{job,5000});
                        if(!owned.WaitForExit(5000)||owned.ExitCode!=125)throw new Exception("Owned child termination was not observed");
                        if(unrelated.HasExited)throw new Exception("Unrelated child was terminated");
                    }finally{TerminateJobObject(job,125);CloseHandle(job);foreach(Process child in new Process[]{owned,unrelated})if(child!=null){if(!child.HasExited)child.Kill();child.WaitForExit(5000);child.Dispose();}}
                    Console.WriteLine("pass:job-empty-wait");return 0;
                }
                case "prepare-private-file":
                case "read-private-file":
                {
                    if(args.Length!=3)throw new Exception("Expected private file fixture path");
                    string target=Path.GetFullPath(args[2]);string parent=Path.GetDirectoryName(target);
                    if(Path.GetFileName(target)!="null-control.txt"||!Path.GetFileName(parent).StartsWith("agy-mcp-null-fault-",StringComparison.Ordinal)||
                        (File.GetAttributes(target)&FileAttributes.ReparsePoint)!=0||(File.GetAttributes(parent)&FileAttributes.ReparsePoint)!=0)throw new Exception("Unexpected file fixture");
                    if(testName=="prepare-private-file")
                    {
                        var acl=new FileSecurity();acl.SetAccessRuleProtection(true,false);
                        acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,AccessControlType.Allow));
                        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-18"),FileSystemRights.FullControl,AccessControlType.Allow));
                        File.SetAccessControl(target,acl);
                    }
                    IntPtr fileHandle=CreateFile(target,testName=="prepare-private-file"?0x60000u:0x20000u,3,IntPtr.Zero,3,0,IntPtr.Zero);
                    if(fileHandle==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
                    try
                    {
                        MethodInfo readRaw=runnerType.GetMethod("ReadKernelDacl",BindingFlags.Static|BindingFlags.NonPublic);
                        var raw=(RawSecurityDescriptor)readRaw.Invoke(null,new object[]{fileHandle});
                        if(testName=="prepare-private-file")
                        {
                            // Set up a canonical private fixture; filesystem inheritance metadata is outside the Null-device contract.
                            raw.SetFlags(raw.ControlFlags&~(ControlFlags.DiscretionaryAclAutoInherited|ControlFlags.DiscretionaryAclAutoInheritRequired));
                            runnerType.GetMethod("WriteKernelDacl",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{fileHandle,raw});
                            raw=(RawSecurityDescriptor)readRaw.Invoke(null,new object[]{fileHandle});
                        }
                        Console.WriteLine(raw.GetSddlForm(AccessControlSections.Access));return 0;
                    }
                    finally{CloseHandle(fileHandle);}
                }
                case "test-private-kernel-handle":
                {
                    // A private named pipe uses file access masks, as does the system Null device.
                    IntPtr hMutex = CreatePrivateFileObject();
                    if (hMutex == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateMutex");
                    try
                    {
                        // Apply grant on private kernel object handle
                        applyKernelGrant.Invoke(null, new object[] { hMutex, SidsTestA });

                        // Verify re-read DACL contains grant
                        MethodInfo readKernel = runnerType.GetMethod("ReadKernelDacl", BindingFlags.Static | BindingFlags.NonPublic);
                        RawSecurityDescriptor sdRead = (RawSecurityDescriptor)readKernel.Invoke(null, new object[] { hMutex });
                        bool found = false;
                        foreach (GenericAce ace in sdRead.DiscretionaryAcl)
                        {
                            var common = ace as CommonAce;
                            if (common != null && common.SecurityIdentifier.Equals(SidsTestA))
                            {
                                found = true;
                                if (common.AccessMask != 0x12019f) throw new Exception("Wrong mask on kernel object grant");
                            }
                        }
                        if (!found) throw new Exception("Kernel object grant not found after apply");

                        // Remove grant on private kernel object handle
                        bool removed = (bool)removeKernelGrant.Invoke(null, new object[] { hMutex, SidsTestA, true });
                        if (!removed) throw new Exception("RemoveKernelObjectGrant returned false");

                        RawSecurityDescriptor sdClean = (RawSecurityDescriptor)readKernel.Invoke(null, new object[] { hMutex });
                        foreach (GenericAce ace in sdClean.DiscretionaryAcl)
                        {
                            var common = ace as CommonAce;
                            if (common != null && common.SecurityIdentifier.Equals(SidsTestA))
                                throw new Exception("Kernel object grant remained after removal");
                        }
                    }
                    finally
                    {
                        CloseHandle(hMutex);
                    }

                    Console.WriteLine("pass:private-kernel-handle");
                    return 0;
                }

                case "test-null-mutex-gate":
                {
                    // Synthetic test: NullDeviceGate mutual exclusion and timeout
                    IDisposable gate1 = (IDisposable)gateAcquire.Invoke(null, new object[] { 5000 });
                    try
                    {
                        bool timeoutObserved = false;
                        var thread = new Thread(delegate()
                        {
                            try
                            {
                                IDisposable gate2 = (IDisposable)gateAcquire.Invoke(null, new object[] { 100 });
                                gate2.Dispose();
                            }
                            catch (TargetInvocationException ex)
                            {
                                if (ex.InnerException != null && ex.InnerException.Message.Contains("timed out"))
                                    timeoutObserved = true;
                            }
                        });
                        thread.Start();
                        thread.Join(5000);
                        if (!timeoutObserved) throw new Exception("Expected NullDeviceGate timeout on concurrent acquire");
                    }
                    finally
                    {
                        gate1.Dispose();
                    }

                    // After disposal, acquire should succeed immediately
                    IDisposable gate3 = (IDisposable)gateAcquire.Invoke(null, new object[] { 5000 });
                    gate3.Dispose();

                    Console.WriteLine("pass:null-mutex-gate");
                    return 0;
                }

                case "test-lease-validation":
                {
                    // Synthetic test: Lease validation for version 1, 2, 3 and legacy rejection
                    Type leaseType = runnerType.GetNestedType("Lease");
                    MethodInfo validateLease = runnerType.GetMethod("ValidateLease", BindingFlags.Static | BindingFlags.NonPublic);
                    var serializer = new JavaScriptSerializer();

                    string tempDir = Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar);
                    string fixtureId = Guid.NewGuid().ToString("N");
                    string cwd = Path.Combine(tempDir, "agy-mcp-copy-null-" + fixtureId);
                    string runtime = Path.Combine(tempDir, "agy-mcp-runtime-null-" + fixtureId);
                    string scratch = Path.Combine(tempDir, "agy-mcp-scratch-null-" + fixtureId);
                    Directory.CreateDirectory(cwd);
                    Directory.CreateDirectory(runtime);
                    Directory.CreateDirectory(scratch);
                    try
                    {
                        Guid nonce = Guid.NewGuid();
                        string leaseFileName = nonce.ToString("N") + ".json";

                        // Version 1 lease
                        object leaseV1 = Activator.CreateInstance(leaseType);
                        leaseType.GetField("version").SetValue(leaseV1, 1);
                        leaseType.GetField("nonce").SetValue(leaseV1, nonce.ToString("D"));
                        leaseType.GetField("profile").SetValue(leaseV1, "agy.test." + nonce.ToString("N"));
                        leaseType.GetField("phase").SetValue(leaseV1, "active");
                        leaseType.GetField("sid").SetValue(leaseV1, SidsTestA.Value);
                        leaseType.GetField("controllerPid").SetValue(leaseV1, Process.GetCurrentProcess().Id);
                        leaseType.GetField("controllerStarted").SetValue(leaseV1, 123456L);
                        leaseType.GetField("cwd").SetValue(leaseV1, cwd);
                        leaseType.GetField("runtime").SetValue(leaseV1, runtime);
                        leaseType.GetField("scratch").SetValue(leaseV1, scratch);
                        Type grantType = runnerType.GetNestedType("Grant");
                        Array emptyGrants = Array.CreateInstance(grantType, 0);
                        leaseType.GetField("grants").SetValue(leaseV1, emptyGrants);

                        validateLease.Invoke(null, new object[] { leaseV1, leaseFileName });

                        // Version 2 lease with nullDeviceGrant = true must be rejected
                        leaseType.GetField("version").SetValue(leaseV1, 2);
                        leaseType.GetField("logon").SetValue(leaseV1, "00000000.000003e8");
                        Type aliasType = runnerType.GetNestedType("AliasPlan");
                        Array aliases = Array.CreateInstance(aliasType, 3);
                        string[] kinds = new string[] { "copy", "runtime", "scratch" };
                        string[] roots = new string[] { cwd, runtime, scratch };
                        char[] drives = new char[] { 'Z', 'Y', 'X' };
                        for (int i = 0; i < 3; i++)
                        {
                            object alias = Activator.CreateInstance(aliasType);
                            aliasType.GetField("kind").SetValue(alias, kinds[i]);
                            aliasType.GetField("physicalRoot").SetValue(alias, roots[i]);
                            aliasType.GetField("customName").SetValue(alias, "AGY.TEST." + nonce.ToString("D").ToUpperInvariant() + "." + kinds[i].ToUpperInvariant());
                            aliasType.GetField("drive").SetValue(alias, drives[i] + ":");
                            aliasType.GetField("aliasRoot").SetValue(alias, drives[i] + ":\\");
                            aliasType.GetField("customTarget").SetValue(alias, "\\??\\" + roots[i]);
                            aliasType.GetField("driveTarget").SetValue(alias, "\\??\\AGY.TEST." + nonce.ToString("D").ToUpperInvariant() + "." + kinds[i].ToUpperInvariant());
                            aliases.SetValue(alias, i);
                        }
                        leaseType.GetField("aliases").SetValue(leaseV1, aliases);
                        leaseType.GetField("nullDeviceGrant").SetValue(leaseV1, true);

                        bool legacyWithGrantRejected = false;
                        try
                        {
                            validateLease.Invoke(null, new object[] { leaseV1, leaseFileName });
                        }
                        catch (TargetInvocationException ex)
                        {
                            if (ex.InnerException != null && ex.InnerException.Message.Contains("Legacy lease cannot declare Null device grant"))
                                legacyWithGrantRejected = true;
                        }
                        if (!legacyWithGrantRejected) throw new Exception("Expected version 2 lease with nullDeviceGrant to be rejected");

                        // Version 3 lease with nullDeviceGrant = true must be accepted
                        leaseType.GetField("jobCreated").SetValue(leaseV1, false);
                        leaseType.GetField("version").SetValue(leaseV1, 3);
                        validateLease.Invoke(null, new object[] { leaseV1, leaseFileName });

                        // Version 3 lease with nullDeviceGrant = false must be accepted
                        leaseType.GetField("nullDeviceGrant").SetValue(leaseV1, false);
                        validateLease.Invoke(null, new object[] { leaseV1, leaseFileName });
                    }
                    finally
                    {
                        try { Directory.Delete(cwd); } catch {}
                        try { Directory.Delete(runtime); } catch {}
                        try { Directory.Delete(scratch); } catch {}
                    }

                    Console.WriteLine("pass:lease-validation");
                    return 0;
                }

                default:
                    Console.Error.WriteLine("Unknown test: " + testName);
                    return 2;
            }
        }
        catch (Exception ex)
        {
            Exception current = ex;
            while (current.InnerException != null) current = current.InnerException;
            Console.Error.WriteLine("Error in " + (args.Length > 1 ? args[1] : "unknown") + ": " + current.Message);
            return 1;
        }
    }
}
