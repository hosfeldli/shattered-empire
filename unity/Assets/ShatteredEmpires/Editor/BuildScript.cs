using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace SE.EditorTools
{
    /// <summary>
    /// Command-line builds (CI and local):
    ///   Unity -batchmode -quit -projectPath unity -executeMethod SE.EditorTools.BuildScript.BuildWindows [-buildOutput PATH]
    /// Exits non-zero when the build fails, so CI stops.
    /// </summary>
    public static class BuildScript
    {
        static string Arg(string name, string def)
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
            return def;
        }

        [MenuItem("Shattered Empires/Build Windows x64")]
        public static void BuildWindows() => Build(BuildTarget.StandaloneWindows64, Arg("-buildOutput", "Build/Windows/ShatteredEmpires.exe"));

        [MenuItem("Shattered Empires/Build macOS")]
        public static void BuildMac() => Build(BuildTarget.StandaloneOSX, Arg("-buildOutput", "Build/macOS/ShatteredEmpires.app"));

        static void Build(BuildTarget target, string output)
        {
            ProjectSetup.Run();
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output)));
            var options = new BuildPlayerOptions
            {
                scenes = new[] { "Assets/ShatteredEmpires/Scenes/Main.unity" },
                locationPathName = output,
                target = target,
                options = Arg("-development", "0") == "1" ? BuildOptions.Development : BuildOptions.None,
            };
            var report = BuildPipeline.BuildPlayer(options);
            var s = report.summary;
            Debug.Log($"Shattered Empires build {s.result}: {s.totalSize / 1048576} MB, {s.totalErrors} errors, {s.totalTime.TotalSeconds:F0} s -> {output}");
            if (s.result == BuildResult.Succeeded)
            {
                // Steam's development app id (Spacewar) until the game has its own
                var dir = target == BuildTarget.StandaloneOSX ? Path.GetDirectoryName(Path.GetFullPath(output)) : Path.GetDirectoryName(Path.GetFullPath(output));
                File.WriteAllText(Path.Combine(dir, "steam_appid.txt"), "480");
            }
            if (Application.isBatchMode) EditorApplication.Exit(s.result == BuildResult.Succeeded ? 0 : 1);
        }
    }
}
