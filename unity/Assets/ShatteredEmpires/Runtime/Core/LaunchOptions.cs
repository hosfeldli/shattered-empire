using System;
using System.Collections.Generic;
using System.Globalization;

namespace SE.Runtime.App
{
    /// <summary>
    /// Command-line options, accepted as "-key value", "--key value" or "--key=value". The same names
    /// as the Godot client where they overlap, so the cross-engine benchmark drives both identically.
    ///   -server URL               ws(s)://host:port/ws (default: the public server)
    ///   -mode ai|observe|sandbox|join|spectate|rejoin|stress
    ///   -match CODE -name NAME -seed N -map small|medium|large
    ///   -battle KEY               sandbox scenario staged through server commands (e.g. massive)
    ///   -perf SECONDS -perf-zooms 14,40 -perf-out FILE    live benchmark (with -battle)
    ///   -stress-seconds N -stress-units N -stress-buildings N -perf-out FILE   offline M2 stress scene
    ///   -quality low|medium|high|ultra   -vsync 0|1
    /// </summary>
    public sealed class LaunchOptions
    {
        readonly Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static LaunchOptions FromCommandLine() => Parse(Environment.GetCommandLineArgs());

        public static LaunchOptions Parse(string[] args)
        {
            var o = new LaunchOptions();
            for (int i = 1; i < args.Length; i++)
            {
                var a = args[i];
                if (!a.StartsWith("-") || a.StartsWith("+")) continue;
                var key = a.TrimStart('-');
                string value = "1";
                int eq = key.IndexOf('=');
                if (eq >= 0) { value = key.Substring(eq + 1); key = key.Substring(0, eq); }
                else if (i + 1 < args.Length && !args[i + 1].StartsWith("-")) value = args[++i];
                o.values[key] = value;
            }
            return o;
        }

        public bool Has(string key) => values.ContainsKey(key);
        public string Get(string key, string def = "") => values.TryGetValue(key, out var v) ? v : def;

        public float Float(string key, float def)
        {
            return values.TryGetValue(key, out var v) && float.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out float f) ? f : def;
        }

        public int Int(string key, int def) => (int)Float(key, def);

        public float[] Floats(string key, params float[] def)
        {
            if (!values.TryGetValue(key, out var v)) return def;
            var parts = v.Split(',');
            var list = new List<float>();
            foreach (var p in parts) if (float.TryParse(p, NumberStyles.Float, CultureInfo.InvariantCulture, out float f)) list.Add(f);
            return list.Count > 0 ? list.ToArray() : def;
        }

        public const string PublicServer = "wss://game.liamhosfeld.com/ws";
        public const string LocalServer = "ws://127.0.0.1:8137/ws";
    }
}
