# Release and distribution

- **Type:** Release runbook
- **Updated:** 2026-11-13
- **Scope:** Hosted server and Windows Unity preview
- **Related:** [Verification](VERIFICATION.md), [current status](UNITY_PROGRESS.md)

## Artifacts and endpoints

A server/source deployment and a Windows ZIP are separate artifacts. Updating one does not update
the other. A running downloaded executable cannot hot-patch itself from changed source.

| Endpoint / source | Purpose |
| --- | --- |
| [Download page](https://game.liamhosfeld.com/download) | Windows Unity preview |
| `wss://game.liamhosfeld.com/ws` | Released player's hosted game connection |
| `/api/health` | Hosted source/version and health evidence |
| `/api/downloads` | Published download manifest |
| [deploy.yml](../.github/workflows/deploy.yml) | Test/e2e gates and main-branch server deployment |
| [unity.yml](../.github/workflows/unity.yml) | Core/live checks and licensed Unity build/publish path |
| [publish-downloads.mjs](../tools/publish-downloads.mjs) | Verify uploads and replace the Windows listing |

Offer Windows Unity only. Do not restore macOS/Godot listings or retired Electron installers.
macOS remains a target platform requiring its own acceptance. Do not imply a Unity auto-updater
exists because the old Electron client had one.

## Prepare

1. Finish the authorized batch, inspect actual Unity scenes and record known defects.
2. Commit intended source without unrelated work. A documentation commit does not make
   implementation work publication-ready.
3. Pass required CI gates. If licensed Unity jobs are skipped, obtain a successful local build
   and record that distinction.
4. Build the Windows player from the intended source. Record commit, Unity pin, backend, options
   and output. Confirm the default endpoint is hosted, not localhost.
5. Update the packaged README with the correct source/build, connection instructions and preview
   limitations. Do not ship a stale build identifier.

Follow the workflows and existing publication authorization. Do not bypass failed gates,
force-update history or report a successful release from an upload alone.

## Windows archive

Include the executable, Data directory, Unity runtime DLLs and required support files. Exclude
DoNotShip/BackUpThisFolder debug directories, logs, credentials, saves and unused asset archives.

Use a Windows-compatible ZIP writer with normalized forward-slash relative entry names. Reject
absolute paths, traversal and malformed entries. Record file count, bytes and SHA-256. A readable
central directory alone does not prove Windows can extract the archive.

Extract with native Explorer/Windows tooling into a fresh directory. Compare expected files,
sizes and hashes. Do not delete old releases or modify the player's installation. Keep packaging
outside a syncing OneDrive folder when necessary for reliable output.

## Publish and verify

Prepare a directory containing the intended Windows ZIP, then use the existing publisher:

```text
node tools/publish-downloads.mjs --dir=PREPARED_ARCHIVE_DIRECTORY --kind=unity-preview --build=SOURCE_COMMIT_SHORT --bucket=AUTHORIZED_DOWNLOAD_BUCKET
```

It uploads to a build-specific path, verifies object size and then replaces the Windows manifest.
Keep private snapshots/tokens private; do not make the shared bucket public to fix downloading.

After publication:

- Confirm hosted health/version and manifest identify the intended source and artifact.
- Open the actual download page at desktop and narrow widths. It must show one Windows ZIP
  and no retired platform/client choices.
- Download through the public link and compare bytes and SHA-256 with the validated archive.
- Verify public-artifact extraction and the player's hosted-server default.
- Record workflow/build IDs, filename/size/hash, extraction results and remaining preview defects.

A private upload, manifest edit or source rollout alone is not a completed download handoff.
Link the public download and report. Existing players need to close the old copy, download/extract
the new ZIP and launch the new executable.

## Private state

Use authenticated tooling without displaying credentials. Keys, tokens, PlayerPrefs sessions,
match snapshots and private state directories never belong in source commits, archives, reports
or tool output. Publish only the intended artifact.
