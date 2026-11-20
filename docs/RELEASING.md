# Releasing (one command)

- **Type:** How-to
- **Updated:** 2026-11-19
- **Scope:** `tools/release.ps1` (Cloud Run server and Windows Unity ZIP), release notes and the in-app updater
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

Write and commit the release notes first (see [Release notes](#release-notes)). The release is HEAD's
short sha (`git rev-parse --short=7 HEAD`). Then:

```powershell
cd D:\Projects\shattered_empires
node tools\release-notes.mjs validate 0.5.0                                              # the notes gate, on its own
powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 0.5.0 -DryRun   # rehearse: read-only checks, prints every change
powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 0.5.0           # server + client
```

| Switch | Effect |
| --- | --- |
| `-Server` / `-Client` | Release only that part. With neither, both are released. |
| `-Version 0.5.0` | Sets the manifest `version`. **Required for a client release**: it names the release notes (`docs/releases/<Version>/notes.json`). A server-only release keeps the published version. |
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

0. **Release notes gate** (client releases, not `-PackageOnly`; before any gcloud call). Stops unless
   `-Version` is given, `docs/releases/<Version>/notes.json` exists, and
   `node tools/release-notes.mjs validate-all --release <Version>` passes for **every** folder in
   `docs/releases`. Under `-DryRun` it runs with `--allow-draft`. A `draft: true` file, its missing screenshots
   and `TODO` placeholders only warn, and only in the newest folder. That folder is either the version being
   rehearsed, or a newer, unreleased "next" version. A newer draft is also allowed in a real release, for example a
   hotfix while the next version's notes are being written, because it isn't uploaded. Every other error still stops
   the rehearsal. The notes folders that get uploaded must also match HEAD, like the shipped files.
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
   - **Release notes.** For every version up to `-Version` (`release-notes.mjs publish-list --release <Version>`),
     uploads `notes.json` and the images it references to
     `gs://stem-471602-se-snapshots/downloads/release-notes/<version>/` (`--cache-control=no-cache`) on every run,
     then lists each folder. Corrections to older notes go out with the next release. The ZIP's manifest entry gets `notes: { version, url }`, with url
     `https://game.liamhosfeld.com/api/release-notes/<Version>`.
   - **Manifest.** Merges the new entry into `downloads/manifest.json`:
     - The new entry goes first, and every other entry is kept.
     - `unity{build,date}` is set to this build, and `version` is kept unless you pass `-Version`.
     - Copies of the manifest before and after are kept in `<ReleaseDir>`.
     - Upload uses `--cache-control=no-cache`.
   - **Verify.**
     - Polls `/api/downloads` until it lists `<sha>`. The server caches the manifest for 60 s.
     - Opens `/download/file/<name>` and checks that it starts a ZIP of the right size.
     - Fetches `/api/release-notes/<Version>`. A failure here only warns: the server must have been deployed
       with the release-notes route.
4. **Push (optional).** Runs `git push` when you pass `-PushBranch`.

## Release notes

Every client release has notes. Together they form a **running changelog**. Players see it in the *What's new*
window the first time a new version starts after an update. The main menu footer's *What's new* link reopens it.
The window lists every version, and lets players search and filter all of them.

### Running changelog

The notes are a running list of every change. They aren't written at the last minute.

- **As a change lands, add it** to the next version's draft (`docs/releases/<next>/notes.json`, `draft: true`). Put it
  under the right category. Start the draft with `node tools/release-notes.mjs draft <next>` right after a release.
  `TODO` placeholders are fine in a draft, for example for work still in progress, but they fail a real release.
- **Each time, revisit the earlier versions.** Fix anything that is wrong, and add a missing `category`. Keep each
  version historically accurate: it describes what *that* version shipped. When a later version changes something,
  don't rewrite the old text. Add a `later` pointer to the old section instead, such as
  `{ "version": "0.7.0", "text": "Nukes are far bigger now..." }`, which the client shows as *Changed in 0.7.0*
  with a link to that version.
- **Validate everything** with `node tools/release-notes.mjs validate-all --allow-draft`. The test
  `test/release-notes.test.js` checks every folder too. Every release re-uploads all of the folders, so corrections
  reach players.

### Workflow

1. **Draft.** Run `node tools/release-notes.mjs draft 0.5.1`. It writes `docs/releases/0.5.1/notes.json` with
   `draft: true`. The draft contains:
   - `since`: the previous notes folder, and the last commit that touched it. For the first release, pass
     `--since 0.4.3 --since-commit 4bd3f1d`.
   - `git log <since.commit>..HEAD` as starting bullets and fixes.
   - The docs changed since then, listed as sources to write from.
2. **Write.** Use real content only: the workstream reports in `docs/gameplay-overhaul/` and
   `docs/performance/`. Take numbers straight from the measured tables. Anything that hasn't been measured
   says so or is left out. Use a plain, short, concrete, player-facing tone, and no names or email addresses.
3. **Screenshots.** After all work is done, run the client with `-release-shots` (see below), writing into the
   notes folder.
4. **Finalise.** Remove `"draft": true`, run `node tools/release-notes.mjs validate 0.5.1`, then commit the folder.
5. **Release** with `tools/release.ps1 -Version 0.5.1`.

### `notes.json` schema (schema 1)

Unknown fields are errors. Keep it compact.

| Field | Rule |
| --- | --- |
| `schema` | `1` |
| `version` | Semver, equal to the folder name and `-Version`. |
| `date` | `YYYY-MM-DD` |
| `title` (≤ 80), `summary` (≤ 500) | Plain sentences. |
| `since` | `{ version, commit }`: the previous released version and its commit. `version` must be older, and it must equal the newest older folder in `docs/releases` when there is one. `commit` must exist and be an ancestor of HEAD. |
| `draft` | Optional. `true` fails a real release, and only warns under `-DryRun` (see the gate above for the unreleased next version). Text containing `TODO` is treated the same way. |
| `sections[]` | 1–14 sections. Each is `{ heading (≤ 60), category?, later?, blocks[] }` with 1–12 blocks. |
| `sections[].category` | Optional, but always set it in new notes. One of `gameplay` (Gameplay), `units` (Units & balance), `ai` (AI), `performance`, `visuals` (Visuals & audio), `interface`, `fixes` or `other`. The client groups sections by category in that order, and filters by it. A section without one reads as *Other*. |
| `sections[].later` | Optional. 1–6 `{ version, text (≤ 260) }` *Changed in* pointers, each to a **newer** version. Old clients ignore them. |
| `fixes[]` | Optional. Up to 60 short strings (≤ 220 each). The client shows them in a collapsed *Smaller fixes* list. |

The blocks (`type` decides the shape):

| `type` | Fields |
| --- | --- |
| `text` | `text` (≤ 700): one short paragraph. |
| `bullets` | `items[]`: 1–14 strings, each ≤ 260. |
| `chart` | `kind` (`bar` or `line`), `title`, `unit` (e.g. `FPS`, `ms`), `labels[]` (1–16; a line chart needs at least 2), `series[]` (1–4 series, each `{ name, values[] }` with one value per label: a number ≥ 0, or `null` for not measured), `caption`, `source` (the doc the numbers come from), optional `better` (`higher` or `lower`). The client draws it. No image is needed. |
| `comparison` | Either a table, `rows[]` of `{ label, before, after }` (1–16 rows) with optional `columns: [beforeHeading, afterHeading]`, or an image pair, `before` and `after` each `{ image, caption?, alt? }`. Optional `title`, `caption`, `source`. |
| `image` | `image` (a file name in the notes folder, `.png` or `.jpg`, no folders), `caption`, optional `alt`. |

The images are checked too. Each must exist and really be a PNG or JPEG, at most 1920×1080 and **600 KB**, and
all of them together at most **8 MB**. Files in the folder that no block references are reported, and they are
not uploaded.

### Serving and the client

- **Server.** `server/releaseNotes.js` serves four routes:
  - `GET /api/release-notes/index`: every version, newest first, as
    `{ schema: 1, latest, versions: [{ version, date, title, summary, since, sections: [{ heading, category }], fixes, draft? }] }`.
    In production, it is built from the bucket listing of `downloads/release-notes/`. That excludes versions newer than
    `latest`, and drafts. It is cached for 5 minutes, and the last good copy is kept if the listing fails. Locally,
    it lists every folder, drafts included and flagged.
  - `GET /api/release-notes/latest`
  - `GET /api/release-notes/<version>`
  - `GET /api/release-notes/<version>/<image>`
  - **In production** it reads `downloads/release-notes/<version>/` from the bucket. `latest` is the manifest
    entry's `notes.version`. The notes JSON is cached for 5 minutes.
  - **Locally** (no bucket, `DOWNLOAD_DIR`, or `RELEASE_NOTES_DIR`) it reads `docs/releases/`. `latest` is the
    highest version folder.
  - Only image file names are served from a version folder. Test: `test/release-notes.test.js`.
- **Client.** `Runtime/UI/ReleaseNotes.cs` shows the window. It is a changelog browser:
  - **Versions** are listed on the left, newest first. *yours* marks the running version. *new* marks versions newer
    than the last notes the player saw (PlayerPrefs `se.notes.seen`). Click a version, or use Up/Down or [ ], to switch.
  - **Each version** shows its summary, then a *Jump to* list of its sections, coloured by category, with
    *Collapse / expand all*. Below that come the sections, grouped under category headings, each one collapsible. Then
    the collapsed *Smaller fixes* list. *Changed in* pointers open the later version.
  - **Search** (Ctrl+F or /) and the **category chips** filter every version at once. Matches are highlighted, and
    each version header opens that version. The notes of all versions load in the background the first time.
  - **When it opens on its own.** On the first start of a version, which it reads from the version in
    `build_id.txt`, that `release.ps1` writes from `-Version`. It compares that with PlayerPrefs `se.notes.seen`.
    It opens only after an in-app update (the updater's `last-update.txt` said ok) or when an earlier version
    was seen. A fresh install shows nothing.
  - **Not blocking.** It is a window beside the menu. Close or Escape dismisses it.
  - **Offline.** It uses the index cached in `persistentDataPath/ReleaseNotes/index.json`, or builds one from the cached
    notes. It shows the notes cached in `persistentDataPath/ReleaseNotes/<version>/`, or a short note. An old server
    without the index route works the same way.
    Images load asynchronously and are cached there too. A failed image shows *Image unavailable offline*.
  - **Testing.** `-whats-new` opens it at start in any build. `-notes-site http://127.0.0.1:8137` reads a
    local server.

### Screenshots: `-release-shots`

```powershell
$env:PORT = 8137; node server\index.js     # a local server on the release tree (production may still run the old one)
ShatteredEmpires.exe -release-shots D:\Projects\shattered_empires\docs\releases\0.5.0 -server ws://127.0.0.1:8137/ws
```

This starts an AI-only observe match: seed 7, unless you pass `-seed`. It lets the match develop for
`-release-shots-wait` real minutes (default 6, at 4× speed). Then it frames a fixed list of views, writes each one
as a PNG of the game camera without the interface, and quits.
- Each PNG is 1280×720. If it is over 580 KB, it is re-encoded with fewer colour bits, then at 960×540.
- A view with nothing on the map to frame is skipped. The log line `RELEASE-SHOTS done: ... skipped [...]`
  lists them.
- Re-run with a longer wait, or another `-seed`, or remove the block from the notes.

| File | View |
| --- | --- |
| `base_closeup.png` | The most developed held base (highest tier, then most defences), close up (distance 3.6). |
| `base_overview.png` | The same base from 9. |
| `defenses_road.png` | A finished defence on or beside a road (2.4). |
| `trenches.png` | The finished trench node with the most links, a junction if there is one (2.0). |
| `river.png` | The river reach nearest that base that isn't a bridge (5). |
| `crater_field.png` | The densest crater field (most impacts within 1.5 units) (3.4). |
| `units_ifv.png` | An Infantry Fighting Vehicle (`exo_infantry`), if one has been built (1.6). |
| `army.png` | The busiest 4×4-hex block of units (6). |
| `shockwave.png` | A staged, client-only heavy explosion over the crater field, captured 0.18 s in, to show the shock front (4). |

Before/after image pairs need captures from the previous build. Make those the same way with the old ZIP, and
rename them `*_before.png`.

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
