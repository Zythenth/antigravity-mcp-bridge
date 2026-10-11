using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

// Native Windows reparse point inspector for portable Node cache paths.
// Inspects file attributes and reparse tags directly without shell invocations.
internal static class ReparseInspector
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFileAttributes(string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, out FileAttributeTagInfo info, uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct FileAttributeTagInfo { public uint attributes, tag; }

    const uint InvalidFileAttributes = 0xFFFFFFFF;
    const uint FileAttributeReparsePoint = 0x400;

    // IO_REPARSE_TAG_CLOUD through IO_REPARSE_TAG_CLOUD_F are placeholders, not name surrogates.
    static bool IsCloudTag(uint tag) { return (tag & 0xFFFF0FFF) == 0x9000001A; }

    static void InspectReparsePoint(string current, uint attrs)
    {
        if ((attrs & FileAttributeReparsePoint) == 0) return;
        IntPtr handle = CreateFile(current, 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open reparse point");
        try
        {
            FileAttributeTagInfo info;
            if (!GetFileInformationByHandleEx(handle, 9, out info, 8))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Inspect reparse tag");
            if ((info.attributes & FileAttributeReparsePoint) != 0 && !IsCloudTag(info.tag))
                throw new InvalidOperationException("Unsafe reparse point detected: " + current);
        }
        finally { CloseHandle(handle); }
    }

    public static int Main(string[] args)
    {
        try
        {
            var decoder = new UnicodeEncoding(false, false, true);
            var base64Regex = new Regex("^[A-Za-z0-9+/]+={0,2}$");
            int count = 0;
            string line;

            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Length == 0 || line.Length % 4 != 0 || !base64Regex.IsMatch(line))
                {
                    throw new ArgumentException("Invalid path record");
                }

                byte[] bytes = Convert.FromBase64String(line);
                string target = decoder.GetString(bytes);
                if (target.Length == 0)
                {
                    throw new ArgumentException("Empty path");
                }
                if (target.IndexOf('\0') >= 0)
                {
                    throw new ArgumentException("NUL character in path");
                }
                count++;

                string root = Path.GetPathRoot(target);
                if (string.IsNullOrEmpty(root) || !Path.IsPathRooted(target))
                {
                    throw new ArgumentException("Path must be absolute");
                }

                string relative = target.Substring(root.Length);
                string current = root;

                uint rootAttrs = GetFileAttributes(current);
                if (rootAttrs == InvalidFileAttributes)
                {
                    int err = Marshal.GetLastWin32Error();
                    throw new Win32Exception(err, "Could not inspect root: " + current);
                }
                InspectReparsePoint(current, rootAttrs);

                string[] parts = relative.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (string part in parts)
                {
                    current = Path.Combine(current, part);
                    uint attrs = GetFileAttributes(current);
                    if (attrs == InvalidFileAttributes)
                    {
                        int err = Marshal.GetLastWin32Error();
                        // Allow non-existent suffix only after all ancestors are verified
                        if (err == 2 || err == 3) // ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND
                        {
                            break;
                        }
                        // Conservative failure on Access Denied (5) or any unexpected error
                        throw new Win32Exception(err, "Failed to inspect path component: " + current);
                    }
                    InspectReparsePoint(current, attrs);
                }
            }

            if (count == 0)
            {
                throw new ArgumentException("Missing paths");
            }

            Console.Out.Write("{\"safe\":true}");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}
