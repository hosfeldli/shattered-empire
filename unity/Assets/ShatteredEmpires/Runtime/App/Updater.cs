using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Networking;

namespace SE.Runtime.App
{
    /// <summary>
    /// In-app updater for the Windows preview build. The installed build is identified by
    /// <c>build_id.txt</c> next to the exe (written by the build script and by tools/release.ps1:
    /// <c>build=&lt;git sha&gt;</c>, <c>version=</c>, <c>date=</c>). On startup (player builds only, never in
    /// the editor, and only when that stamp exists) the public manifest <c>/api/downloads</c> is fetched; a
    /// unity-preview ZIP with a different build and a later date is an update.
    ///
    /// Installing: the ZIP is downloaded to persistentDataPath/Updates, its size and SHA-256 are checked
    /// against the manifest, it is extracted to a staging folder there, and a small .cmd helper is written
    /// and started. The helper waits for this process to exit, backs up exactly the files it will replace
    /// (Updates/backup), copies the new build over the install folder (mirroring only the game's own
    /// _Data folder; nothing else in the install folder is deleted), restores the backup on failure, and
    /// relaunches the game. Settings live in PlayerPrefs / persistentDataPath and are never touched.
    /// No network, a read-only install folder or any failure only produce a message; the game carries on.
    /// Command line: <c>-noUpdateCheck</c> skips the check.
    /// </summary>
    public static class Updater
    {
        public const string Site = "https://game.liamhosfeld.com";
        public const string DownloadPage = Site + "/download";

        public enum Phase { Idle, Checking, UpToDate, Available, Downloading, Verifying, Extracting, Installing, Failed }

        public static Phase State { get; private set; } = Phase.Idle;
        /// <summary>A human-readable line for the current phase (failure reason, progress text).</summary>
        public static string Message { get; private set; } = "";
        /// <summary>The failure is best solved by downloading manually (the banner offers the download page).</summary>
        public static bool OfferDownloadPage { get; private set; }
        /// <summary>0–1 during Downloading / Verifying / Extracting.</summary>
        public static float Progress { get; private set; }
        /// <summary>Raised on the main thread whenever State, Message or Progress changes.</summary>
        public static event Action Changed;

        public static string AvailableBuild { get; private set; } = "";
        public static string AvailableVersion { get; private set; } = "";
        public static long AvailableSize { get; private set; }

        /// <summary>Settings > Interface: check for updates on startup.</summary>
        public static bool CheckOnStartup
        {
            get => PlayerPrefs.GetInt("se.set.updateCheck", 1) == 1;
            set { PlayerPrefs.SetInt("se.set.updateCheck", value ? 1 : 0); PlayerPrefs.Save(); }
        }

        // ------------------------------------------------------------------ the installed build
        public sealed class Stamp
        {
            public string Build = "", Version = "", Date = "";
            public DateTime When => DateTime.TryParse(Date, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var d) ? d : DateTime.MinValue;
        }

        static Stamp current;
        static bool stampRead;
        /// <summary>The installed build (null in the editor or when build_id.txt is missing).</summary>
        public static Stamp Current
        {
            get
            {
                if (stampRead) return current;
                stampRead = true;
                try { current = ReadStamp(Path.Combine(InstallDir, "build_id.txt")); } catch { current = null; }
                return current;
            }
        }

        /// <summary>The build id for display ("" when unknown).</summary>
        public static string CurrentBuild => Current?.Build ?? "";

        static Stamp ReadStamp(string path)
        {
            if (!File.Exists(path)) return null;
            var s = new Stamp();
            foreach (var raw in File.ReadAllLines(path))
            {
                int eq = raw.IndexOf('=');
                if (eq <= 0) continue;
                string k = raw.Substring(0, eq).Trim().ToLowerInvariant(), v = raw.Substring(eq + 1).Trim();
                if (k == "build") s.Build = v; else if (k == "version") s.Version = v; else if (k == "date") s.Date = v;
            }
            return string.IsNullOrEmpty(s.Build) ? null : s;
        }

        /// <summary>The folder holding the exe (the Windows player's dataPath is &lt;install&gt;/&lt;Exe&gt;_Data).</summary>
        static string InstallDir => Path.GetDirectoryName(Path.GetFullPath(Application.dataPath));
        static string DataFolderName => Path.GetFileName(Path.GetFullPath(Application.dataPath));
        static string ExeName => (DataFolderName.EndsWith("_Data", StringComparison.OrdinalIgnoreCase)
            ? DataFolderName.Substring(0, DataFolderName.Length - 5) : "ShatteredEmpires") + ".exe";
        static string WorkDir => Path.Combine(Application.persistentDataPath, "Updates");
        static string ResultFile => Path.Combine(WorkDir, "last-update.txt");

        /// <summary>Whether this process can update itself at all (why not, otherwise).</summary>
        public static bool Supported(out string why)
        {
            why = "";
            if (Application.isEditor) { why = "editor"; return false; }
            if (Application.platform != RuntimePlatform.WindowsPlayer) { why = "not Windows"; return false; }
            foreach (var a in Environment.GetCommandLineArgs())
                if (string.Equals(a, "-noUpdateCheck", StringComparison.OrdinalIgnoreCase)) { why = "-noUpdateCheck"; return false; }
            if (Current == null) { why = "no build_id.txt (local build)"; return false; }
            return true;
        }

        // ------------------------------------------------------------------ check
        static bool startupDone;
        static JObject offered;   // the manifest file entry on offer

        /// <summary>Run once per process (the main menu calls it): report the last update and check for a new one.</summary>
        public static void StartupCheck()
        {
            if (startupDone) return;
            startupDone = true;
            if (!Supported(out string why)) { Debug.Log("[updater] off: " + why); return; }
            ReportLastUpdate();
            if (State == Phase.Failed) return;
            if (CheckOnStartup) _ = Check();
        }

        static void ReportLastUpdate()
        {
            try
            {
                if (!File.Exists(ResultFile)) return;
                string r = File.ReadAllText(ResultFile).Trim();
                File.Delete(ResultFile);
                Debug.Log("[updater] last update: " + r);
                if (r.StartsWith("failed", StringComparison.OrdinalIgnoreCase))
                {
                    OfferDownloadPage = true;
                    Set(Phase.Failed, "The last update could not be installed; the previous build was kept.");
                }
                // a successful swap leaves nothing to clean up except leftovers of earlier attempts
                CleanWorkDir(keepBackup: true);
            }
            catch (Exception e) { Debug.LogWarning("[updater] " + e.Message); }
        }

        /// <summary>Fetch the manifest; silently Idle on any network or parse problem.</summary>
        public static async Task Check()
        {
            if (State == Phase.Checking || State >= Phase.Downloading && State <= Phase.Installing) return;
            Set(Phase.Checking, "");
            try
            {
                using (var req = UnityWebRequest.Get(Site + "/api/downloads"))
                {
                    req.timeout = 15;
                    await Send(req);
                    if (req.result != UnityWebRequest.Result.Success) { Debug.Log("[updater] no manifest: " + req.error); Set(Phase.Idle, ""); return; }
                    var m = JObject.Parse(req.downloadHandler.text);
                    var file = PickFile(m);
                    if (file == null) { Set(Phase.UpToDate, ""); return; }
                    string build = (string)file["build"] ?? (string)m["unity"]?["build"] ?? "";
                    var cur = Current;
                    DateTime fileDate = DateTime.TryParse((string)file["date"] ?? "", System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out var fd) ? fd : DateTime.MinValue;
                    bool newer = cur != null && !string.IsNullOrEmpty(build)
                        && !string.Equals(build, cur.Build, StringComparison.OrdinalIgnoreCase)
                        && (cur.When == DateTime.MinValue || fileDate == DateTime.MinValue || fileDate > cur.When.AddMinutes(1));
                    if (!newer) { Set(Phase.UpToDate, ""); return; }
                    offered = file;
                    AvailableBuild = build;
                    AvailableVersion = (string)m["version"] ?? "";
                    AvailableSize = (long?)file["size"] ?? 0;
                    OfferDownloadPage = false;
                    Set(Phase.Available, "");
                    Debug.Log($"[updater] update available: {cur?.Build} -> {build} ({AvailableSize / 1048576} MB)");
                }
            }
            catch (Exception e) { Debug.Log("[updater] check failed: " + e.Message); Set(Phase.Idle, ""); }
        }

        static JObject PickFile(JObject m)
        {
            JObject best = null; DateTime bestDate = DateTime.MinValue;
            if (!(m["files"] is JArray files)) return null;
            foreach (var t in files)
            {
                if (!(t is JObject f)) continue;
                if ((string)f["kind"] != "unity-preview" || (string)f["platform"] != "win") continue;
                string name = (string)f["name"] ?? "";
                if (!name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty((string)f["sha256"])) continue;
                DateTime.TryParse((string)f["date"] ?? "", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AdjustToUniversal, out var d);
                if (best == null || d > bestDate) { best = f; bestDate = d; }
            }
            return best;
        }

        // ------------------------------------------------------------------ install
        static UnityWebRequest active;
        static bool cancelled;

        /// <summary>Dismiss the offer for this session.</summary>
        public static void Later()
        {
            if (State == Phase.Available || State == Phase.Failed) Set(Phase.Idle, "");
        }

        /// <summary>Stop a running download (the partial file is removed).</summary>
        public static void Cancel()
        {
            if (State != Phase.Downloading) return;
            cancelled = true;
            try { active?.Abort(); } catch { }
        }

        /// <summary>Download, verify, extract, start the helper and quit.</summary>
        public static async void InstallNow()
        {
            if (offered == null || !(State == Phase.Available || State == Phase.Failed)) return;
            var file = offered;
            string name = (string)file["name"], sha = ((string)file["sha256"] ?? "").ToLowerInvariant();
            long size = (long?)file["size"] ?? 0;
            OfferDownloadPage = false;
            cancelled = false;
            try
            {
                if (!CanWrite(InstallDir) || !CanWrite(Path.Combine(InstallDir, DataFolderName)))
                {
                    OfferDownloadPage = true;
                    Set(Phase.Failed, "The game folder is read-only, so the update can't be installed here. Download it from the website instead.");
                    return;
                }
                Directory.CreateDirectory(WorkDir);
                CleanWorkDir(keepBackup: true);
                string zip = Path.Combine(WorkDir, SafeName(name));

                // 1. download (reused when a verified copy is already here)
                bool have = File.Exists(zip) && (size <= 0 || new FileInfo(zip).Length == size);
                if (have)
                {
                    have = await Hashed(zip, "Checking the downloaded update…") == sha;
                }
                if (!have)
                {
                    string part = zip + ".part";
                    TryDelete(part);
                    Set(Phase.Downloading, "Downloading…", 0f);
                    using (var req = new UnityWebRequest(Site + "/download/file/" + Uri.EscapeDataString(name), UnityWebRequest.kHttpVerbGET))
                    {
                        req.downloadHandler = new DownloadHandlerFile(part) { removeFileOnAbort = true };
                        active = req;
                        var op = req.SendWebRequest();
                        while (!op.isDone)
                        {
                            // the server streams without content-length: progress comes from the manifest's size
                            float p = size > 0 ? Mathf.Clamp01(req.downloadedBytes / (float)size) : Mathf.Max(0f, req.downloadProgress);
                            Set(Phase.Downloading, $"Downloading… {req.downloadedBytes / 1048576} / {size / 1048576} MB", p);
                            await Task.Delay(150);
                        }
                        active = null;
                        if (cancelled) { TryDelete(part); Set(Phase.Available, ""); return; }
                        if (req.result != UnityWebRequest.Result.Success)
                            throw new UpdateError("The download failed (" + req.error + "). Check your connection and try again.", true);
                    }
                    if (size > 0 && new FileInfo(part).Length != size)
                    { TryDelete(part); throw new UpdateError("The download was incomplete. Please try again.", true); }
                    string got = await Hashed(part, "Verifying…");
                    if (got != sha) { TryDelete(part); throw new UpdateError("The download was damaged (checksum mismatch). Please try again.", true); }
                    TryDelete(zip);
                    File.Move(part, zip);
                }

                // 2. extract to staging
                string staging = Path.Combine(WorkDir, "staging");
                Set(Phase.Extracting, "Unpacking…", 0f);
                progressFromWorker = 0f;
                var extract = Task.Run(() => Extract(zip, staging, f => progressFromWorker = f));
                while (!extract.IsCompleted) { Set(Phase.Extracting, "Unpacking…", progressFromWorker); await Task.Delay(100); }
                await extract;   // rethrows
                if (!File.Exists(Path.Combine(staging, ExeName)) || !Directory.Exists(Path.Combine(staging, DataFolderName)))
                    throw new UpdateError($"The update doesn't contain {ExeName}; it was not installed.", true);
                string stampPath = Path.Combine(staging, "build_id.txt");
                if (!File.Exists(stampPath))
                    File.WriteAllText(stampPath, $"build={AvailableBuild}\nversion={AvailableVersion}\ndate={(string)file["date"]}\n");

                // 3. hand over to the helper and quit
                Set(Phase.Installing, "Restarting to finish the update…", 1f);
                string script = WriteHelper(staging, zip, AvailableBuild);
                var psi = new System.Diagnostics.ProcessStartInfo("cmd.exe", "/c \"\"" + script + "\"\"")
                {
                    UseShellExecute = true,
                    WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
                    WorkingDirectory = WorkDir,
                };
                System.Diagnostics.Process.Start(psi);
                Debug.Log("[updater] helper started: " + script);
                await Task.Delay(400);
                Application.Quit();
            }
            catch (UpdateError e) { active = null; OfferDownloadPage = e.Link; Set(Phase.Failed, e.Message); }
            catch (UnauthorizedAccessException e) { active = null; OfferDownloadPage = true; Set(Phase.Failed, "No permission to write the update (" + e.Message + "). Download it from the website instead."); }
            catch (Exception e) { active = null; OfferDownloadPage = true; Debug.LogException(e); Set(Phase.Failed, "The update failed: " + e.Message); }
        }

        static volatile float progressFromWorker;

        static async Task<string> Hashed(string path, string msg)
        {
            progressFromWorker = 0f;
            Set(Phase.Verifying, msg, 0f);
            var t = Task.Run(() => Sha256(path, f => progressFromWorker = f));
            while (!t.IsCompleted) { Set(Phase.Verifying, msg, progressFromWorker); await Task.Delay(100); }
            return await t;
        }

        sealed class UpdateError : Exception
        {
            public readonly bool Link;
            public UpdateError(string msg, bool link) : base(msg) { Link = link; }
        }

        // ------------------------------------------------------------------ helpers
        static void Set(Phase p, string msg, float progress = -1f)
        {
            bool changed = p != State || msg != Message || (progress >= 0f && Mathf.Abs(progress - Progress) > 0.002f);
            State = p; Message = msg ?? "";
            if (progress >= 0f) Progress = progress;
            if (changed) Changed?.Invoke();
        }

        static Task Send(UnityWebRequest r)
        {
            var tcs = new TaskCompletionSource<bool>();
            var op = r.SendWebRequest();
            if (op.isDone) tcs.TrySetResult(true);
            else op.completed += _ => tcs.TrySetResult(true);
            return tcs.Task;
        }

        static bool CanWrite(string dir)
        {
            try
            {
                string probe = Path.Combine(dir, ".se-write-test-" + Guid.NewGuid().ToString("N").Substring(0, 8));
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return true;
            }
            catch { return false; }
        }

        static string SafeName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return string.IsNullOrEmpty(name) ? "update.zip" : name;
        }

        static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { } }

        static void CleanWorkDir(bool keepBackup)
        {
            try
            {
                if (!Directory.Exists(WorkDir)) return;
                string staging = Path.Combine(WorkDir, "staging");
                if (Directory.Exists(staging)) Directory.Delete(staging, true);
                foreach (var f in Directory.GetFiles(WorkDir, "*.part")) TryDelete(f);
                foreach (var f in Directory.GetFiles(WorkDir, "*.cmd")) TryDelete(f);
                if (!keepBackup && Directory.Exists(Path.Combine(WorkDir, "backup"))) Directory.Delete(Path.Combine(WorkDir, "backup"), true);
            }
            catch (Exception e) { Debug.LogWarning("[updater] cleanup: " + e.Message); }
        }

        static string Sha256(string path, Action<float> progress)
        {
            using (var sha = SHA256.Create())
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20))
            {
                var buf = new byte[1 << 20];
                long total = Math.Max(1, fs.Length), done = 0;
                int n;
                while ((n = fs.Read(buf, 0, buf.Length)) > 0)
                {
                    sha.TransformBlock(buf, 0, n, null, 0);
                    done += n;
                    progress?.Invoke(done / (float)total);
                }
                sha.TransformFinalBlock(buf, 0, 0);
                var sb = new StringBuilder(64);
                foreach (byte b in sha.Hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        /// <summary>Extract with both '/' and '\' separators (older release ZIPs used '\'), refusing paths outside the folder.</summary>
        static void Extract(string zip, string dest, Action<float> progress)
        {
            if (Directory.Exists(dest)) Directory.Delete(dest, true);
            Directory.CreateDirectory(dest);
            string root = Path.GetFullPath(dest).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            using (var archive = ZipFile.OpenRead(zip))
            {
                int i = 0, count = Math.Max(1, archive.Entries.Count);
                foreach (var e in archive.Entries)
                {
                    progress?.Invoke(i++ / (float)count);
                    string rel = e.FullName.Replace('\\', '/').TrimStart('/');
                    if (rel.Length == 0) continue;
                    string full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
                    if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new UpdateError("The update contains an unsafe path; it was not installed.", true);
                    if (rel.EndsWith("/")) { Directory.CreateDirectory(full); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(full));
                    using (var src = e.Open())
                    using (var dst = new FileStream(full, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                        src.CopyTo(dst);
                }
                progress?.Invoke(1f);
            }
        }

        /// <summary>
        /// The swap helper. It backs up only what it will overwrite, copies the staging folder over the
        /// install folder (robocopy /E: nothing else in the install folder is removed), mirrors the game's
        /// own _Data folder (so stale assets go), restores the backup when a copy fails, writes
        /// last-update.txt for the next start, and relaunches the exe either way.
        /// </summary>
        static string WriteHelper(string staging, string zip, string build)
        {
            string install = InstallDir.TrimEnd('\\', '/');
            string backup = Path.Combine(WorkDir, "backup");
            string log = Path.Combine(WorkDir, "update.log");
            string script = Path.Combine(WorkDir, "apply-update.cmd");
            int pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            const string Q = " /R:5 /W:1 /NP /NJH /NJS /NFL /NDL";

            var topFiles = new List<string>();
            foreach (var f in Directory.GetFiles(staging)) topFiles.Add("\"" + Path.GetFileName(f) + "\"");
            var topDirs = new List<string>();
            foreach (var d in Directory.GetDirectories(staging)) topDirs.Add(Path.GetFileName(d));

            var s = new StringBuilder();
            s.AppendLine("@echo off");
            s.AppendLine("chcp 65001 >nul");
            s.AppendLine("setlocal EnableExtensions");
            s.AppendLine($"set \"SRC={staging.TrimEnd('\\', '/')}\"");
            s.AppendLine($"set \"DST={install}\"");
            s.AppendLine($"set \"BAK={backup}\"");
            s.AppendLine($"set \"LOG={log}\"");
            s.AppendLine($"set \"RESULT={ResultFile}\"");
            s.AppendLine($"set \"ZIP={zip}\"");
            s.AppendLine($"set \"EXE={Path.Combine(install, ExeName)}\"");
            s.AppendLine($"echo Shattered Empires update to {build} > \"%LOG%\"");
            s.AppendLine("set /a N=0");
            s.AppendLine(":wait");
            s.AppendLine($"tasklist /FI \"PID eq {pid}\" /NH 2>nul | find \" {pid} \" >nul");
            s.AppendLine("if errorlevel 1 goto go");
            s.AppendLine("set /a N+=1");
            s.AppendLine("if %N% GEQ 120 goto stuck");
            s.AppendLine("timeout /t 1 /nobreak >nul");
            s.AppendLine("goto wait");
            s.AppendLine(":stuck");
            s.AppendLine("echo the game did not exit >> \"%LOG%\"");
            s.AppendLine("> \"%RESULT%\" echo failed: the game did not close");
            s.AppendLine("goto launch");
            s.AppendLine(":go");
            s.AppendLine("ping -n 3 127.0.0.1 >nul");
            // backup: the top-level files and folders the update replaces
            s.AppendLine("if exist \"%BAK%\" rmdir /s /q \"%BAK%\"");
            s.AppendLine("mkdir \"%BAK%\"");
            if (topFiles.Count > 0)
            {
                s.AppendLine($"robocopy \"%DST%\" \"%BAK%\" {string.Join(" ", topFiles)}{Q} >> \"%LOG%\"");
                s.AppendLine("if errorlevel 8 goto backupfail");
            }
            foreach (var d in topDirs)
            {
                s.AppendLine($"if exist \"%DST%\\{d}\" robocopy \"%DST%\\{d}\" \"%BAK%\\{d}\" /E{Q} >> \"%LOG%\"");
                s.AppendLine("if errorlevel 8 goto backupfail");
            }
            // install
            s.AppendLine($"robocopy \"%SRC%\" \"%DST%\" /E{Q} >> \"%LOG%\"");
            s.AppendLine("if errorlevel 8 goto restore");
            s.AppendLine($"robocopy \"%SRC%\\{DataFolderName}\" \"%DST%\\{DataFolderName}\" /MIR{Q} >> \"%LOG%\"");
            s.AppendLine("if errorlevel 8 goto restore");
            s.AppendLine($"> \"%RESULT%\" echo ok {build}");
            s.AppendLine("echo installed >> \"%LOG%\"");
            s.AppendLine("rmdir /s /q \"%SRC%\"");
            s.AppendLine("del /q \"%ZIP%\" >nul 2>&1");
            s.AppendLine("goto launch");
            s.AppendLine(":backupfail");
            s.AppendLine("echo backup failed, nothing changed >> \"%LOG%\"");
            s.AppendLine("> \"%RESULT%\" echo failed: could not back up the current build");
            s.AppendLine("goto launch");
            s.AppendLine(":restore");
            s.AppendLine("echo install failed, restoring the backup >> \"%LOG%\"");
            s.AppendLine($"robocopy \"%BAK%\" \"%DST%\" /E{Q} >> \"%LOG%\"");
            s.AppendLine($"if exist \"%BAK%\\{DataFolderName}\" robocopy \"%BAK%\\{DataFolderName}\" \"%DST%\\{DataFolderName}\" /MIR{Q} >> \"%LOG%\"");
            s.AppendLine("> \"%RESULT%\" echo failed: restored the previous build");
            s.AppendLine(":launch");
            s.AppendLine("start \"\" /D \"%DST%\" \"%EXE%\"");
            s.AppendLine("endlocal");
            s.AppendLine("(goto) 2>nul & del \"%~f0\"");
            File.WriteAllText(script, s.ToString().Replace("\r\n", "\n").Replace("\n", "\r\n"), new UTF8Encoding(false));
            return script;
        }
    }
}
