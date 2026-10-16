using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;

internal static class GitEnvironmentHarness
{
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("Usage: harness <request-json-path>");
                return 1;
            }
            string json = File.ReadAllText(args[0]);
            var serializer = new JavaScriptSerializer();
            var input = serializer.Deserialize<Dictionary<string, object>>(json);

            var requestType = typeof(WindowsTestRunner).GetNestedType("Request", BindingFlags.Public | BindingFlags.NonPublic);
            var req = Activator.CreateInstance(requestType, true);

            if (input.ContainsKey("environment"))
            {
                var envDict = input["environment"] as Dictionary<string, object>;
                var typedEnv = new Dictionary<string, string>();
                if (envDict != null)
                {
                    foreach (var pair in envDict)
                    {
                        typedEnv[pair.Key] = pair.Value == null ? null : pair.Value.ToString();
                    }
                }
                requestType.GetField("environment").SetValue(req, typedEnv);
            }

            if (input.ContainsKey("maxFiles"))
            {
                requestType.GetField("maxFiles").SetValue(req, Convert.ToInt32(input["maxFiles"]));
            }

            if (input.ContainsKey("cwd"))
            {
                requestType.GetField("cwd").SetValue(req, input["cwd"] != null ? input["cwd"].ToString() : null);
            }

            var aliasType = typeof(WindowsTestRunner).GetNestedType("AliasPlan", BindingFlags.Public | BindingFlags.NonPublic);
            var aliasesList = input["aliases"] as System.Collections.IList;
            var aliasesArray = Array.CreateInstance(aliasType, aliasesList.Count);

            for (int i = 0; i < aliasesList.Count; i++)
            {
                var aDict = aliasesList[i] as Dictionary<string, object>;
                var aObj = Activator.CreateInstance(aliasType, true);
                foreach (var pair in aDict)
                {
                    var field = aliasType.GetField(pair.Key, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                    if (field != null)
                    {
                        field.SetValue(aObj, pair.Value == null ? null : pair.Value.ToString());
                    }
                }
                aliasesArray.SetValue(aObj, i);
            }

            var projMethod = typeof(WindowsTestRunner).GetMethod("ProjectEnvironment", BindingFlags.NonPublic | BindingFlags.Static);
            if (projMethod == null)
            {
                Console.Error.WriteLine("ProjectEnvironment method not found");
                return 2;
            }

            try
            {
                var result = projMethod.Invoke(null, new object[] { req, aliasesArray }) as Dictionary<string, string>;
                var output = new Dictionary<string, object>
                {
                    { "success", true },
                    { "environment", result }
                };
                Console.WriteLine(serializer.Serialize(output));
                return 0;
            }
            catch (TargetInvocationException ex)
            {
                var output = new Dictionary<string, object>
                {
                    { "success", false },
                    { "error", ex.InnerException != null ? ex.InnerException.Message : ex.Message }
                };
                Console.WriteLine(serializer.Serialize(output));
                return 0;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Harness error: " + ex);
            return 3;
        }
    }
}
