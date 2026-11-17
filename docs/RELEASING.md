# Releasing (one command)

- **Type:** How-to
- **Updated:** 2026-11-17
- **Scope:** `tools/release.ps1` (Cloud Run server and Windows Unity ZIP) and the in-app updater
- **Related:** [Release and distribution](RELEASE.md)

## One-time setup on a PC

Use Windows PowerShell 5.1. Call `gcloud.cmd`, not the bash wrapper, which breaks on this PC.

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\se-gcloud" | Out-Null
$env:CLOUDSDK_CONFIG = "$env:LOCALAPPDATA\se-gcloud"
gcloud.cmd auth activate-service-account --key-file=<path to the service-account key .json>
gcloud.cmd config set project stem-471602
```

The key file stays git-ignored (`stem-*.json`). Never commit, print or upload it. The script
checks that every key-like `.json` in the repository root:
- is ignored, untracked and unstaged;
- does not appear in `gcloud meta list-files-for-upload`, which lists what Cloud Build would upload.

To use a different gcloud configuration directory, pass `-GcloudConfig <dir>`.

## Release

Commit first. The release is HEAD's short sha (`git rev-parse --short=7 HEAD`). Then:

```powershell
cd D:\Projects\shattered_empires
powershell -ExecutionPolicy Bypass -File tools\release.ps1 -DryRun     # rehearse: read-only checks, prints every change
powershell -ExecutionPolicy Bypass -File tools\release.ps1             # server + client
```

| Switch | Effect |
| --- | --- |
| `-Server` / `-Client` | Release only that part. With neither, both are released. |
| `-Version 0.5.0` | Sets the manifest `version`. Without it, the published one is kept. |
| `-DryRun` | Changes nothing. Read-only gcloud calls (`describe`, `cat`, `list`) still run. |
| `-PackageOnly` | Builds the client ZIP locally (for testing the updater) and publishes nothing. |
| `-SkipBuild` | Client: zip the existing `unity/Build/Windows`. Server: require an existing image. |
| `-SkipTests` | Skips `npm test`. |
| `-AllowDirty` | Releases even though shipped files differ from HEAD. |
| `-Force` | Re-zips and re-uploads a client build that is already published. |
| `-FullVerify` | Downloads the published ZIP again and compares its SHA-256. |
| `-PushBranch feature/unity-client-2026-11-16` | Runs `git push origin HEAD:<branch>` at the end. |
| `-UnityExe`, `-ReleaseDir`, `-Project`, `-Region`, `-Bucket`, `-Site`, ... | Override the defaults. |

### What it does

Every step is skipped when it's already done, so you can re-run the script after a failure.

1. **Sanity.** Checks the key files, then checks that HEAD holds the shipped files: `server/`,
   `package*.json` and `Dockerfile` for the server, and `unity/Assets|Packages|ProjectSettings`
   for the client. `.mcp.json`, `unity/Assets/Plugins*`, `unity/Assets/Screenshots*` and
   `out_*.txt` are ignored. Then it runs `npm test`, and writes the log to
   `%TEMP%\se-release-npm-test-<sha>.log`.
2. **Server.**
   - Runs `gcloud builds submit --tag us-east1-docker.pkg.dev/stem-471602/shattered-empires/shattered-empires:<sha> --region us-east1 --async .`.
     This step is skipped when that tag already exists.
   - Polls `gcloud builds describe <id>` every 15 s. This account isn't allowed to stream the logs.
   - Runs `gcloud run deploy shattered-empires --image <tag> --update-env-vars APP_VERSION=<sha>`.
   - Polls `/api/health` until it reports `<sha>`.
   - If that image is already live and healthy, the whole server step is skipped.
3. **Client.**
   - **Build.** If the Unity editor has `unity/` open (checked by process command line and
     `Temp/UnityLockfile`), a batch build is impossible, so the existing
     `unity/Build/Windows` is used. Build it first in the editor with
     *Shattered Empires > Build Windows x64*.
   - Otherwise the script runs `Unity.exe -batchmode -quit -projectPath unity -executeMethod SE.EditorTools.BuildScript.BuildWindows -buildId <sha>`.
     The Unity path comes from `ProjectVersion.txt`. The log is `<ReleaseDir>\unity-build-<sha>.log`.
   - The script warns if the build looks older than the client source.
   - **Package.**
     - Copies the build to `<ReleaseDir>\stage-<sha>` without the `*DoNotShip*` folders.
     - Writes `build_id.txt` (`build=<sha>`, `version=`, `date=`).
     - Zips it to `<ReleaseDir>\ShatteredEmpires-Windows-<sha>.zip` with `/` separators, and computes the SHA-256.
     - `<ReleaseDir>` defaults to `D:\Projects\se_scratch\release`.
     - A `.zip.json` record next to the ZIP lets a re-run reuse the identical file.
   - **Upload.** Uploads to
     `gs://stem-471602-se-snapshots/downloads/unity-preview-<sha>/ShatteredEmpires-Windows-<sha>.zip`,
     then checks the object's size.
   - **Manifest.** Merges the new entry into `downloads/manifest.json`:
     - The new entry goes first, and every other entry is kept.
     - `unity{build,date}` is set to this build, and `version` is kept unless you pass `-Version`.
     - Copies of the manifest before and after are kept in `<ReleaseDir>`.
     - Upload uses `--cache-control=no-cache`.
   - **Verify.**
     - Polls `/api/downloads` until it lists `<sha>`. The server caches the manifest for 60 s.
     - Opens `/download/file/<name>` and checks that it starts a ZIP of the right size.
4. **Push (optional).** Runs `git push` when you pass `-PushBranch`.

## Commits on this PC

This PC has no git identity, so commit with:

```powershell
git -c user.name="Codex" -c user.email="codex@localhost" commit -m "..."
```

Don't stage `.mcp.json`, `unity/Assets/Plugins(.meta)` or `unity/Assets/Screenshots(.meta)`.

## In-app updater (client)

The updater is implemented in `Runtime/App/Updater.cs`, with the menu strip in
`Runtime/UI/UpdateBanner.cs`.

- **The build stamp.** Each build knows its own id from `build_id.txt` next to the exe:
  - `BuildScript` writes it after every build: `-buildId` or `SE_BUILD_ID`, otherwise git HEAD.
  - `release.ps1` rewrites it in the ZIP with the published sha and date.
  - The menu footer shows `build <sha>`.
- **The check.** It runs when the main menu is created:
  - Only in Windows player builds that have a stamp. Never in the editor, and never with `-noUpdateCheck`.
  - It can be turned off in *Settings > Interface > Check for updates on startup*.
  - It fetches `/api/downloads`. A `unity-preview` ZIP counts as an update when its build differs
    and its date is later.
  - If the network is down, nothing is shown.
- **The banner.** It shows *Update available, Update now / Later* above the menu footer.
- **Update now.**
  1. The ZIP downloads to `%USERPROFILE%\AppData\LocalLow\<company>\Shattered Empires\Updates`,
     with progress and Cancel.
  2. Its size and SHA-256 are checked against the manifest.
  3. It's extracted to `Updates\staging`, with path-traversal checks.
  4. The game writes `Updates\apply-update.cmd` and starts it, then quits.
- **What the helper does.**
  1. Waits for the game's PID to exit.
  2. Backs up only the files and folders it will replace to `Updates\backup`.
  3. Runs `robocopy /E` from staging into the install folder. Nothing else there is deleted.
  4. Mirrors only `ShatteredEmpires_Data`.
  5. If a copy fails, restores the backup.
  6. Writes `Updates\last-update.txt` and relaunches the exe.
- **On the next start,** a failed update shows a message and a link to the download page. Its log is
  `Updates\update.log`.
- **Settings are safe.** PlayerPrefs and persistentDataPath are never touched.
- **Read-only install folder.** If the game folder can't be written (for example
  `Program Files`), the banner explains why and links to https://game.liamhosfeld.com/download.
- **Older builds.** Builds made before the updater have no stamp and no updater. Their players need
  to download the new build once by hand.

`tools/publish-downloads.mjs` is the CI (Linux) publisher. On Windows it now starts `gcloud.cmd`
through `cmd.exe`, and it keeps the other manifest entries. For local releases, use `release.ps1`.
