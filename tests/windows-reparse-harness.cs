using System;
using System.Reflection;

internal static class ReparseHarness
{
    public static int Main(string[] args)
    {
        try
        {
            Type program = Assembly.LoadFrom(args[0]).GetType(args[1], true);
            MethodInfo cloudTag = program.GetMethod("IsCloudTag", BindingFlags.Static | BindingFlags.NonPublic);
            for (uint variant = 0; variant < 16; variant++)
                if (!(bool)cloudTag.Invoke(null, new object[] { 0x9000001Au | (variant << 12) }))
                    throw new Exception("Rejected a documented Cloud Files tag");
            foreach (uint tag in new uint[] { 0, 0xA0000003, 0xA000000C, 0x8000001B, 0x9001001A, 0xB000001A })
                if ((bool)cloudTag.Invoke(null, new object[] { tag }))
                    throw new Exception("Accepted a link or unknown tag");

            if (args.Length > 2)
            {
                Type grantType = program.GetNestedType("Grant");
                object grant = Activator.CreateInstance(grantType);
                grantType.GetField("path").SetValue(grant, args[2]);
                grantType.GetField("rights").SetValue(grant, "read");
                object pinned = program.GetMethod("PinGrant", BindingFlags.Static | BindingFlags.NonPublic)
                    .Invoke(null, new object[] { grant, 100 });
                ((IDisposable)pinned).Dispose();
            }
            Console.WriteLine("safe");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine((error.InnerException ?? error).Message);
            return 1;
        }
    }
}
