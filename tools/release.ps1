<#
.SYNOPSIS
  One-command release of Shattered Empires: the Cloud Run game server and/or the Windows Unity preview ZIP.

.DESCRIPTION
  Windows PowerShell 5.1 compatible. See docs/RELEASING.md.

    powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 0.5.0 -DryRun   # rehearse everything, change nothing
    powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Version 0.5.0           # server + client
    powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Server                  # server only
    powershell -ExecutionPolicy Bypass -File tools\release.ps1 -Client -Version 0.5.0

  Release notes gate: a client release (not -PackageOnly) needs -Version and docs/releases/<Version>/notes.json
  that passes `node tools/release-notes.mjs validate <Version>` (with --allow-draft under -DryRun). The check runs
  before anything remote, and stops -DryRun too. The notes folder is uploaded to
  gs://<bucket>/downloads/release-notes/<Version>/ and the manifest entry gets notes {version, url}.

  Steps (each one is skipped when it is already done, so re-running is safe):
    1. sanity: service-account keys are git-ignored, untracked, unstaged and excluded by .gcloudignore;
       the files that ship are committed (HEAD is what gets released); npm test.
    2. server: Cloud Build image <region>-docker.pkg.dev/<project>/<repo>/shattered-empires:<sha> (skipped
       when the tag exists), Cloud Run deploy with APP_VERSION=<sha> (skipped when already live), then
       /api/health is polled until it reports <sha>.
    3. client: Unity batch build when the editor is not running (else the existing unity/Build/Windows),
       staging without *DoNotShip* folders, build_id.txt stamp, ZIP + SHA-256, upload to
       gs://<bucket>/downloads/unity-preview-<sha>/, manifest.json merge (other entries kept), then
       /api/downloads and /download/file/<name> are checked.

  Read-only gcloud calls (describe, list, cat) also run in -DryRun; every call that changes something is
  printed instead of executed.
#>
[CmdletBinding()]
param(
    [switch]$Server,            # release the server (default: both when neither -Server nor -Client)
    [switch]$Client,            # release the Windows client ZIP
    [switch]$SkipBuild,         # client: never run Unity, ZIP the existing build; server: require an existing image
    [switch]$SkipTests,         # skip npm test
    [switch]$DryRun,            # change nothing (no Cloud Build, deploy, upload, manifest write, Unity build or push)
    [string]$Version = '',      # manifest "version" (e.g. 0.5.0); default keeps the published one
    [switch]$AllowDirty,        # release although shipped files differ from HEAD (the sha then lies a little)
    [switch]$Force,             # client: re-zip and re-upload even when this build is already published
    [switch]$FullVerify,        # client: download the published ZIP again and compare its SHA-256
    [switch]$PackageOnly,       # client only: build/stage/zip locally (e.g. to test the updater), publish nothing
    [string]$PushBranch = '',   # optional: git push origin HEAD:<branch> after a successful release
    [string]$GcloudConfig = '', # CLOUDSDK_CONFIG directory (default %LOCALAPPDATA%\se-gcloud)
    [string]$UnityExe = '',     # default: Unity Hub path for unity/ProjectSettings/ProjectVersion.txt
    [string]$ReleaseDir = '',   # local ZIP/stage folder (default <repo>\..\se_scratch\release)
    [string]$Project = 'stem-471602',
    [string]$Region = 'us-east1',
    [string]$Service = 'shattered-empires',
    [string]$Repository = 'shattered-empires',
    [string]$Bucket = 'stem-471602-se-snapshots',
    [string]$Site = 'https://game.liamhosfeld.com',
    [int]$BuildTimeoutMin = 30,
    [int]$HealthTimeoutSec = 600
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if ($PackageOnly) { $Server = $false; $Client = $true }
elseif (-not $Server -and -not $Client) { $Server = $true; $Client = $true }
$Repo = Split-Path -Parent $PSScriptRoot
if (-not $GcloudConfig) { $GcloudConfig = Join-Path $env:LOCALAPPDATA 'se-gcloud' }
if (-not $ReleaseDir) { $ReleaseDir = Join-Path (Split-Path -Parent $Repo) 'se_scratch\release' }
$Started = Get-Date
$Summary = New-Object System.Collections.Generic.List[string]

# ------------------------------------------------------------------ output helpers
function Step([string]$t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Info([string]$t) { Write-Host "    $t" }
function Ok([string]$t) { Write-Host "    OK  $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "    !!  $t" -ForegroundColor Yellow }
function Dry([string]$t) { Write-Host "    [dry-run] $t" -ForegroundColor DarkYellow }
function Fail([string]$t) { throw "release stopped: $t" }

# ------------------------------------------------------------------ tools
function Find-Gcloud {
    $c = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
    if (Test-Path $p) { return $p }
    $p = 'C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
    if (Test-Path $p) { return $p }
    Fail 'gcloud.cmd not found (install the Google Cloud SDK)'
}

$script:Gcloud = $null
# Runs gcloud.cmd (the bash wrapper does not work on this PC). -Mutating calls are only printed in -DryRun.
# -Quiet hides stderr and returns $null on failure instead of stopping.
function Invoke-GCloud {
    param([Parameter(Mandatory = $true)][string[]]$GArgs, [switch]$Mutating, [switch]$Quiet)
    $GArgs = @($GArgs) + @("--project=$Project")
    $line = 'gcloud ' + ($GArgs -join ' ')
    if ($Mutating -and ($DryRun -or $PackageOnly)) { Dry $line; return "" }
    Write-Verbose $line
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) { $out = & $script:Gcloud @GArgs 2>$null } else { $out = & $script:Gcloud @GArgs }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    if ($code -ne 0) {
        if ($Quiet) { return $null }
        Fail "gcloud exited $code`: $line"
    }
    if ($null -eq $out) { return '' }
    return (@($out) -join "`n").Trim()
}

function G {
    # a simple function: $args passes git flags (-q, -1, --format=...) through untouched
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & git.exe -C $Repo @args 2>$null; $script:GitCode = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
    if ($null -eq $out) { return '' }
    return (@($out) -join "`n").Trim()
}

function Get-Json([string]$url) {
    $sep = '?'
    if ($url.Contains('?')) { $sep = '&' }
    return Invoke-RestMethod -Uri ($url + $sep + '_=' + [DateTime]::UtcNow.Ticks) -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 20
}

function Write-Utf8([string]$path, [string]$text) {
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
}

function Get-Sha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }

function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

# ------------------------------------------------------------------ 0. context
Step 'Release context'
$Sha = G rev-parse --short=7 HEAD
if ($script:GitCode -ne 0 -or -not $Sha) { Fail 'not a git repository' }
$Branch = G rev-parse --abbrev-ref HEAD
$Subject = G log -1 --format=%s
Info "repo     $Repo"
Info "commit   $Sha ($Branch) $Subject"
$targets = @()
if ($Server) { $targets += 'server' }
if ($Client) { $targets += 'client' }
Info ("targets  " + ($targets -join ' + '))
if ($DryRun) { Warn 'DRY RUN: nothing will be built, deployed, uploaded or pushed' }
if ($PackageOnly) { Warn 'PACKAGE ONLY: the client ZIP is made locally; nothing is uploaded or deployed' }
if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$') { Fail "-Version '$Version' is not like 0.5.0" }

# ------------------------------------------------------------------ release notes gate (local only, before any gcloud call)
# Players see these notes after updating (Runtime/UI/ReleaseNotes.cs). A client release cannot go out without them.
$NotesRef = $null; $NotesFiles = @(); $NotesSince = ''
if ($Client -and -not $PackageOnly) {
    Step 'Release notes'
    if (-not $Version) { Fail "-Version is required for a client release: players are shown docs/releases/<Version>/notes.json after updating (start one with: node tools/release-notes.mjs draft <Version>)" }
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { Fail 'node.exe not found (needed to validate the release notes)' }
    $notesTool = Join-Path $Repo 'tools\release-notes.mjs'
    $nargs = @($notesTool, 'validate', $Version)
    if ($DryRun) { $nargs += '--allow-draft' }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $nout = & $nodeCmd.Source @nargs 2>&1; $ncode = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
    foreach ($l in @($nout)) { if ($l) { Info ([string]$l) } }
    if ($ncode -ne 0) { Fail "release notes for $Version are missing or invalid: fix docs/releases/$Version/notes.json (see docs/RELEASING.md)" }
    $NotesFiles = @((& $nodeCmd.Source $notesTool 'files' $Version) | Where-Object { $_ })
    $NotesSince = [string](Get-Prop (Get-Prop (Get-Content -Raw -Encoding UTF8 (Join-Path $Repo "docs\releases\$Version\notes.json") | ConvertFrom-Json) 'since') 'version')
    $NotesRef = [ordered]@{ version = $Version; url = "$Site/api/release-notes/$Version" }
    Ok ("docs/releases/$Version/notes.json is valid ({0} file(s) to upload, since $NotesSince)" -f $NotesFiles.Count)
}

$script:Gcloud = Find-Gcloud
$env:CLOUDSDK_CONFIG = $GcloudConfig
if (-not (Test-Path $GcloudConfig)) {
    Fail ("gcloud config '$GcloudConfig' does not exist. One-time setup (PowerShell):`n" +
        "      `$env:CLOUDSDK_CONFIG='$GcloudConfig'`n" +
        "      gcloud.cmd auth activate-service-account --key-file=<path to the service-account key .json>`n" +
        "      gcloud.cmd config set project $Project`n" +
        "    or pass -GcloudConfig <dir> for an existing configuration.")
}
$Account = Invoke-GCloud -GArgs @('config', 'get-value', 'account') -Quiet
if (-not $Account) { Fail "no active gcloud account in $GcloudConfig (run: gcloud.cmd auth activate-service-account --key-file=...)" }
Info "gcloud   $Account (config $GcloudConfig)"

# ------------------------------------------------------------------ 1. sanity
Step 'Sanity checks'
# service-account keys: never tracked, never staged, never in the Cloud Build upload (names are not printed)
$keys = @(Get-ChildItem -LiteralPath $Repo -File -Filter '*.json' | Where-Object { $_.Name -match '^stem-.*\.json$|service-account|-key\.json$|^sa\.json$' })
$staged = @((G diff --cached --name-only) -split "`n" | Where-Object { $_ })
foreach ($k in $keys) {
    $null = G check-ignore -q $k.Name
    if ($script:GitCode -ne 0) { Fail 'a service-account key in the repo root is NOT git-ignored (.gitignore: stem-*.json)' }
    if (G ls-files $k.Name) { Fail 'a service-account key is TRACKED by git: git rm --cached it and rotate the key' }
    if ($staged -contains $k.Name) { Fail 'a service-account key is STAGED: git restore --staged it' }
}
if (-not (Test-Path (Join-Path $Repo '.gcloudignore'))) { Fail '.gcloudignore is missing (Cloud Build would upload the whole working tree, keys included)' }
# what Cloud Build would really upload, per .gcloudignore (read-only)
Push-Location $Repo
try { $upload = @((Invoke-GCloud -GArgs @('meta', 'list-files-for-upload', '.')) -split "`n" | Where-Object { $_ } | ForEach-Object { $_.Replace('\', '/') }) } finally { Pop-Location }
$keyNames = @($keys | ForEach-Object { $_.Name })
$badUpload = @($upload | Where-Object { $keyNames -contains $_ -or $_ -match '(^|/)(stem-[^/]*\.json|[^/]*service-account[^/]*\.json|[^/]*-key\.json|sa\.json)$' })
if ($badUpload.Count -gt 0) { Fail 'Cloud Build would upload a service-account key: fix .gcloudignore' }
$oddUpload = @($upload | Where-Object { $_ -notmatch '^(server/|Dockerfile$|\.dockerignore$|package(-lock)?\.json$)' })
if ($oddUpload.Count -gt 0) { Warn ("Cloud Build would also upload: " + (($oddUpload | Select-Object -First 5) -join ', ')) }
Ok ("service-account key(s): {0} found; git-ignored, untracked, unstaged; Cloud Build uploads {1} files, none of them keys" -f $keys.Count, $upload.Count)
if ($staged.Count -gt 0) { Warn ("{0} staged file(s) not committed; HEAD ($Sha) is what gets released" -f $staged.Count) }

# the shipped files must equal HEAD; local-only clutter is ignored
$ignore = '^(\.mcp\.json|out_[^/]*\.txt|unity/Assets/(Plugins|Screenshots)(\.meta|/.*)?)$'
$dirty = @((G status --porcelain --untracked-files=all) -split "`n" | Where-Object { $_ } | ForEach-Object { $_.Substring(3).Trim('"') } | Where-Object { $_ -notmatch $ignore })
$dirtyServer = @($dirty | Where-Object { $_ -match '^(server/|package(-lock)?\.json$|Dockerfile$|\.dockerignore$|\.gcloudignore$)' })
$dirtyClient = @($dirty | Where-Object { $_ -match '^unity/(Assets|Packages|ProjectSettings)/' })
function Check-Dirty([string]$what, [string[]]$files) {
    if ($files.Count -eq 0) { Ok "$what files match HEAD"; return }
    $msg = "{0} uncommitted {1} file(s), e.g. {2}" -f $files.Count, $what, (($files | Select-Object -First 3) -join ', ')
    if ($AllowDirty) { Warn "$msg (-AllowDirty)" }
    elseif ($DryRun -or $PackageOnly) { Warn "$msg (a real release stops here: commit first or pass -AllowDirty)" }
    else { Fail "$msg. Commit them (or pass -AllowDirty)." }
}
if ($Server) { Check-Dirty 'server' $dirtyServer }
if ($Client) { Check-Dirty 'client' $dirtyClient }
if ($NotesRef) { Check-Dirty 'release notes' @($dirty | Where-Object { $_ -like "docs/releases/$Version/*" }) }

if ($SkipTests) { Warn 'npm test skipped (-SkipTests)' }
else {
    Info 'npm test ...'
    Push-Location $Repo
    try {
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & npm.cmd test 2>&1 | Out-File -Encoding utf8 (Join-Path $env:TEMP "se-release-npm-test-$Sha.log")
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
    } finally { Pop-Location }
    if ($code -ne 0) { Fail "npm test failed (log: $env:TEMP\se-release-npm-test-$Sha.log)" }
    Ok 'npm test passed'
}

# ------------------------------------------------------------------ 2. server
function Wait-Health([string]$want) {
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $last = ''
    while ((Get-Date) -lt $deadline) {
        try { $h = Get-Json "$Site/api/health"; $last = [string](Get-Prop $h 'version') } catch { $last = "error: $($_.Exception.Message)" }
        if ($last -eq $want) { return $true }
        Info "health reports '$last', waiting for '$want' ..."
        Start-Sleep -Seconds 10
    }
    return $false
}

if ($Server) {
    Step "Server $Sha"
    $Tag = "$Region-docker.pkg.dev/$Project/$Repository/shattered-empires:$Sha"
    $liveImage = Invoke-GCloud -GArgs @('run', 'services', 'describe', $Service, "--region=$Region", '--format=value(spec.template.spec.containers[0].image)') -Quiet
    $liveVersion = ''
    try { $liveVersion = [string](Get-Prop (Get-Json "$Site/api/health") 'version') } catch { Warn "health check failed: $($_.Exception.Message)" }
    Info "live     $liveImage (health version '$liveVersion')"
    if ($liveImage -eq $Tag -and $liveVersion -eq $Sha) {
        Ok "server $Sha is already live; nothing to do"
        $Summary.Add("server: already live at $Sha")
    } else {
        $digest = Invoke-GCloud -GArgs @('artifacts', 'docker', 'images', 'describe', $Tag, '--format=value(image_summary.digest)') -Quiet
        if ($digest) { Ok "image exists ($digest); not rebuilding" }
        elseif ($SkipBuild) { Fail "image $Tag does not exist and -SkipBuild was given" }
        else {
            Info "Cloud Build -> $Tag"
            Push-Location $Repo
            try { $buildId = Invoke-GCloud -GArgs @('builds', 'submit', "--tag=$Tag", "--region=$Region", '--async', '--format=value(id)', '.') -Mutating } finally { Pop-Location }
            if (-not $DryRun -and -not $PackageOnly) {
                $buildId = ($buildId -split "`n" | Where-Object { $_ -match '^[0-9a-f-]{36}$' } | Select-Object -Last 1)
                if (-not $buildId) { Fail 'Cloud Build did not return a build id' }
                Info "build $buildId (log streaming is not permitted for this account; polling status)"
                $deadline = (Get-Date).AddMinutes($BuildTimeoutMin)
                $status = ''
                while ($true) {
                    $s = Invoke-GCloud -GArgs @('builds', 'describe', $buildId, "--region=$Region", '--format=value(status)') -Quiet
                    if ($s -and $s -ne $status) { $status = $s; Info ("{0:HH:mm:ss} {1}" -f (Get-Date), $status) }
                    if ($status -eq 'SUCCESS') { break }
                    if ($status -match '^(FAILURE|INTERNAL_ERROR|TIMEOUT|CANCELLED|EXPIRED)$') {
                        Fail "Cloud Build $buildId ended $status (console: https://console.cloud.google.com/cloud-build/builds;region=$Region/$buildId?project=$Project)"
                    }
                    if ((Get-Date) -gt $deadline) { Fail "Cloud Build $buildId still '$status' after $BuildTimeoutMin min" }
                    Start-Sleep -Seconds 15
                }
                Ok "image built: $Tag"
            }
        }
        Info "deploy $Service <- $Tag"
        $null = Invoke-GCloud -GArgs @('run', 'deploy', $Service, "--image=$Tag", "--region=$Region", "--update-env-vars=APP_VERSION=$Sha", '--quiet') -Mutating
        if ($DryRun) { Dry "poll $Site/api/health until version = $Sha" }
        else {
            if (-not (Wait-Health $Sha)) { Fail "health did not report $Sha within $HealthTimeoutSec s" }
            Ok "$Site/api/health reports $Sha"
        }
        $Summary.Add("server: $Tag deployed")
    }
}

# ------------------------------------------------------------------ 3. client
if ($Client) {
    Step "Client $Sha"
    $UnityProject = Join-Path $Repo 'unity'
    $BuildDir = Join-Path $UnityProject 'Build\Windows'
    $ExeName = 'ShatteredEmpires.exe'
    $ZipName = "ShatteredEmpires-Windows-$Sha.zip"
    $ObjectPath = "unity-preview-$Sha/$ZipName"
    $ObjectUrl = "gs://$Bucket/downloads/$ObjectPath"
    $ManifestUrl = "gs://$Bucket/downloads/manifest.json"
    if (-not (Test-Path $ReleaseDir)) { New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null }
    $Zip = Join-Path $ReleaseDir $ZipName
    $ZipInfo = "$Zip.json"   # remembers sha256/size/date so a re-run republishes the identical file

    # current manifest (read-only)
    $manifestText = Invoke-GCloud -GArgs @('storage', 'cat', $ManifestUrl) -Quiet
    $manifest = $null
    if ($manifestText) { $manifest = $manifestText | ConvertFrom-Json }
    else { Warn 'no manifest.json in the bucket yet; a new one will be written' }
    $oldFiles = @()
    if ($manifest -and (Get-Prop $manifest 'files')) { $oldFiles = @($manifest.files) }
    $published = @($oldFiles | Where-Object { (Get-Prop $_ 'name') -eq $ZipName } | Select-Object -First 1)
    $remoteSize = Invoke-GCloud -GArgs @('storage', 'objects', 'describe', $ObjectUrl, '--format=value(size)') -Quiet
    $mVersion = Get-Prop $manifest 'version'
    $mBuild = Get-Prop (Get-Prop $manifest 'unity') 'build'
    Info "manifest version '$mVersion', unity build '$mBuild', $($oldFiles.Count) file entr$(if ($oldFiles.Count -eq 1) { 'y' } else { 'ies' })"
    $NewVersion = $mVersion
    if ($Version) { $NewVersion = $Version }
    if ($NotesRef -and $mVersion -and $mVersion -ne $Version -and $NotesSince -ne $mVersion) { Warn "the notes say since $NotesSince but the published version is $mVersion" }

    $already = $published.Count -gt 0 -and $remoteSize -and ([long]$remoteSize -eq [long](Get-Prop $published[0] 'size')) -and $mBuild -eq $Sha -and -not $PackageOnly
    if ($already -and -not $Force) {
        Ok "$ZipName is already published and listed; skipping build, ZIP and upload (-Force to redo)"
        $entry = $published[0]
    } else {
        # 3a. the Unity build
        $unityRunning = $false
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='Unity.exe'" -ErrorAction SilentlyContinue)
        $projKey = $UnityProject.ToLowerInvariant().Replace('\', '/').TrimEnd('/')
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine.ToLowerInvariant().Replace('\', '/').Contains($projKey)) { $unityRunning = $true }
        }
        $lock = Join-Path $UnityProject 'Temp\UnityLockfile'
        if (-not $unityRunning -and (Test-Path $lock)) {
            try { $fs = [IO.File]::Open($lock, 'Open', 'ReadWrite', 'None'); $fs.Dispose() } catch { $unityRunning = $true }
        }
        $buildNow = -not $SkipBuild -and -not $unityRunning
        if ($SkipBuild) { Info 'using the existing build (-SkipBuild)' }
        elseif ($unityRunning) { Warn 'the Unity editor has the project open, so a batch build is impossible; using the existing build (build it via "Shattered Empires/Build Windows x64")' }
        if ($buildNow) {
            if (-not $UnityExe) {
                $pv = Get-Content (Join-Path $UnityProject 'ProjectSettings\ProjectVersion.txt') | Where-Object { $_ -match '^m_EditorVersion:\s*(\S+)' } | Select-Object -First 1
                $ver = ($pv -replace '^m_EditorVersion:\s*', '').Trim()
                $UnityExe = "C:\Program Files\Unity\Hub\Editor\$ver\Editor\Unity.exe"
            }
            if (-not (Test-Path $UnityExe)) { Fail "Unity not found at $UnityExe (pass -UnityExe or -SkipBuild)" }
            $log = Join-Path $ReleaseDir "unity-build-$Sha.log"
            $uargs = @('-batchmode', '-quit', '-projectPath', "`"$UnityProject`"", '-executeMethod', 'SE.EditorTools.BuildScript.BuildWindows', '-buildId', $Sha, '-logFile', "`"$log`"")
            if ($NewVersion) { $uargs += @('-buildVersion', $NewVersion) }
            if ($DryRun) { Dry ("`"$UnityExe`" " + ($uargs -join ' ')) }
            else {
                Info "Unity batch build (log $log) ..."
                $proc = Start-Process -FilePath $UnityExe -ArgumentList $uargs -Wait -PassThru -NoNewWindow
                if ($proc.ExitCode -ne 0) { Fail "Unity build failed (exit $($proc.ExitCode)); see $log" }
                Ok 'Unity build succeeded'
            }
        }
        if (-not (Test-Path (Join-Path $BuildDir $ExeName))) { Fail "no build at $BuildDir\$ExeName" }
        # how old is the build compared with the client source?
        $stampFile = Join-Path $BuildDir 'build_id.txt'
        $marker = $stampFile
        if (-not (Test-Path $marker)) { $marker = Join-Path $BuildDir 'steam_appid.txt' }
        if (-not (Test-Path $marker)) { $marker = Join-Path $BuildDir $ExeName }
        $builtAt = (Get-Item $marker).LastWriteTime
        $stampBuild = ''
        if (Test-Path $stampFile) { $stampBuild = ((Get-Content $stampFile | Where-Object { $_ -match '^build=' } | Select-Object -First 1) -replace '^build=', '').Trim() }
        $lastClientCommit = G log -1 --format=%cI unity/Assets unity/Packages unity/ProjectSettings
        Info ("build    {0} (made {1:yyyy-MM-dd HH:mm}, stamp '{2}')" -f $BuildDir, $builtAt, $stampBuild)
        if ($stampBuild -and $stampBuild -ne $Sha) {
            $null = G diff --quiet $stampBuild HEAD unity/Assets unity/Packages unity/ProjectSettings
            if ($script:GitCode -ne 0) { Warn "the build was made from $stampBuild and client source changed since; rebuild unless those changes were already in the working tree when it was built" }
        } elseif (-not $stampBuild -and $lastClientCommit -and $builtAt -lt [DateTime]::Parse($lastClientCommit)) {
            Warn "the build predates the last client commit ($lastClientCommit); rebuild unless it was made from that working tree"
        }

        # 3b. stage, stamp and zip (a ZIP already made for this sha is reused so its hash stays stable)
        $Date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        $reuse = (Test-Path $Zip) -and (Test-Path $ZipInfo) -and -not $Force -and -not $buildNow
        if ($reuse) {
            $zi = Get-Content -Raw $ZipInfo | ConvertFrom-Json
            if ((Get-Item $Zip).Length -ne [long]$zi.size -or (Get-Sha256 $Zip) -ne $zi.sha256) { $reuse = $false; Warn 'local ZIP does not match its record; re-zipping' }
            else { $Date = $zi.date; Ok "reusing $Zip" }
        }
        if (-not $reuse) {
            $Stage = Join-Path $ReleaseDir "stage-$Sha"
            if ($DryRun) {
                Dry "robocopy $BuildDir -> $Stage (without *DoNotShip*), write build_id.txt (build=$Sha), zip -> $Zip"
            } else {
                if (Test-Path $Stage) { Remove-Item -Recurse -Force -LiteralPath $Stage }
                $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
                & robocopy.exe $BuildDir $Stage /E /XD '*DoNotShip*' /R:2 /W:1 /NP /NFL /NDL /NJH /NJS | Out-Null
                $rc = $LASTEXITCODE
                $ErrorActionPreference = $prev
                if ($rc -ge 8) { Fail "robocopy to the stage failed ($rc)" }
                Get-ChildItem -LiteralPath $Stage -Recurse -Directory -Filter '*DoNotShip*' | Remove-Item -Recurse -Force
                Write-Utf8 (Join-Path $Stage 'build_id.txt') "build=$Sha`nversion=$NewVersion`ndate=$Date`n"
                $tmp = "$Zip.tmp"
                if (Test-Path $tmp) { Remove-Item -Force $tmp }
                Info "zipping $Stage ..."
                Add-Type -AssemblyName System.IO.Compression
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                $fs = [IO.File]::Open($tmp, 'Create')
                try {
                    $za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
                    try {
                        $root = (Resolve-Path $Stage).Path.TrimEnd('\') + '\'
                        foreach ($f in Get-ChildItem -LiteralPath $Stage -Recurse -File) {
                            # forward slashes: Compress-Archive in PowerShell 5.1 writes '\' separators
                            $rel = $f.FullName.Substring($root.Length).Replace('\', '/')
                            $e = $za.CreateEntry($rel, [IO.Compression.CompressionLevel]::Optimal)
                            $e.LastWriteTime = $f.LastWriteTime
                            $out = $e.Open()
                            try { $in = [IO.File]::OpenRead($f.FullName); try { $in.CopyTo($out) } finally { $in.Dispose() } } finally { $out.Dispose() }
                        }
                    } finally { $za.Dispose() }
                } finally { $fs.Dispose() }
                if (Test-Path $Zip) { Remove-Item -Force $Zip }
                Move-Item $tmp $Zip
                $zsha = Get-Sha256 $Zip
                Write-Utf8 $ZipInfo ((@{ sha256 = $zsha; size = (Get-Item $Zip).Length; date = $Date; build = $Sha } | ConvertTo-Json) + "`n")
                Ok ("{0} ({1:N0} MB)" -f $Zip, ((Get-Item $Zip).Length / 1MB))
            }
        }
        if (Test-Path $Zip) { $ZipSize = (Get-Item $Zip).Length; $ZipSha = Get-Sha256 $Zip }
        else { $ZipSize = 0; $ZipSha = '<sha256 of the new zip>' }
        Info "sha256   $ZipSha"

        # 3c. upload (skipped when the same bytes are already there)
        if ($remoteSize -and [long]$remoteSize -eq $ZipSize -and $published.Count -gt 0 -and (Get-Prop $published[0] 'sha256') -eq $ZipSha) {
            Ok "$ObjectUrl already uploaded"
        } else {
            Info "upload -> $ObjectUrl"
            $null = Invoke-GCloud -GArgs @('storage', 'cp', $Zip, $ObjectUrl) -Mutating
            if (-not $DryRun -and -not $PackageOnly) {
                $sz = Invoke-GCloud -GArgs @('storage', 'objects', 'describe', $ObjectUrl, '--format=value(size)')
                if ([long]$sz -ne $ZipSize) { Fail "upload incomplete ($sz of $ZipSize bytes); manifest not changed" }
                Ok "uploaded $sz bytes"
            }
        }
        $entry = [ordered]@{
            platform = 'win'; kind = 'unity-preview'; name = $ZipName; label = 'Download for Windows (ZIP)'
            size = [long]$ZipSize; sha256 = $ZipSha; path = $ObjectPath; build = $Sha; date = $Date
        }
    }

    # 3c'. release notes next to the ZIP: downloads/release-notes/<Version>/ (notes.json and its images), re-uploaded
    # every run (small); the manifest entry points at them so the client and /api/release-notes/latest find them
    $notesListed = $true
    if ($NotesRef) {
        $NotesUrl = "gs://$Bucket/downloads/release-notes/$Version/"
        Info ("release notes -> $NotesUrl ({0} file(s))" -f $NotesFiles.Count)
        $null = Invoke-GCloud -GArgs (@('storage', 'cp') + $NotesFiles + @($NotesUrl, '--cache-control=no-cache')) -Mutating
        if (-not $DryRun) {
            $listedNotes = Invoke-GCloud -GArgs @('storage', 'ls', $NotesUrl)
            if ($listedNotes -notmatch 'notes\.json') { Fail "release notes not found at $NotesUrl after the upload; manifest not changed" }
            Ok 'release notes uploaded'
        }
        $notesListed = $published.Count -gt 0 -and [string](Get-Prop (Get-Prop $published[0] 'notes') 'version') -eq $Version
        if ($entry -is [System.Collections.IDictionary]) { $entry['notes'] = $NotesRef }
        else { $entry | Add-Member -NotePropertyName notes -NotePropertyValue ([pscustomobject]$NotesRef) -Force }
    }

    # 3d. manifest merge: this build first, every other entry kept
    $entryDate = [string](Get-Prop ([pscustomobject]$entry) 'date')
    $others = @($oldFiles | Where-Object { (Get-Prop $_ 'name') -ne $ZipName })
    $newManifest = [ordered]@{ version = $NewVersion; unity = [ordered]@{ build = $Sha; date = $entryDate }; files = @(@($entry) + $others) }
    $newText = (ConvertTo-Json -InputObject $newManifest -Depth 8) + "`n"
    if ($already -and -not $Force -and $NewVersion -eq $mVersion -and $notesListed) { Ok 'manifest already lists this build' }
    else {
        $local = Join-Path $ReleaseDir "manifest-$Sha.json"
        if ($manifestText) { Write-Utf8 (Join-Path $ReleaseDir "manifest-before-$Sha.json") ($manifestText + "`n") }
        Write-Utf8 $local $newText
        Info "manifest -> $ManifestUrl (local copy $local)"
        if ($DryRun) { Write-Host ($newText -split "`n" | ForEach-Object { "      $_" } | Out-String) -ForegroundColor DarkGray }
        $null = Invoke-GCloud -GArgs @('storage', 'cp', $local, $ManifestUrl, '--cache-control=no-cache', '--content-type=application/json') -Mutating
        if (-not $DryRun -and -not $PackageOnly) {
            $check = (Invoke-GCloud -GArgs @('storage', 'cat', $ManifestUrl)) | ConvertFrom-Json
            if ((Get-Prop (Get-Prop $check 'unity') 'build') -ne $Sha) { Fail 'manifest re-read does not show the new build' }
            Ok 'manifest updated'
        }
    }

    # 3e. public verification (the server caches the manifest for 60 s)
    if ($DryRun -or $PackageOnly) {
        Dry "poll $Site/api/downloads until unity.build = $Sha, then GET $Site/download/file/$ZipName$(if ($NotesRef) { " and $Site/api/release-notes/$Version" })"
        try { $d = Get-Json "$Site/api/downloads"; Info ("public now: build '{0}', file '{1}'" -f (Get-Prop (Get-Prop $d 'unity') 'build'), (@($d.files) | Select-Object -First 1 | ForEach-Object { $_.name })) } catch { Warn "api/downloads: $($_.Exception.Message)" }
    } else {
        $deadline = (Get-Date).AddSeconds(150)
        while ($true) {
            $pub = ''
            try { $d = Get-Json "$Site/api/downloads"; $pub = [string](Get-Prop (Get-Prop $d 'unity') 'build') } catch { $pub = 'error' }
            if ($pub -eq $Sha) { break }
            if ((Get-Date) -gt $deadline) { Fail "api/downloads still lists '$pub' after 150 s" }
            Info "api/downloads lists '$pub' (cached up to 60 s) ..."
            Start-Sleep -Seconds 10
        }
        Ok "$Site/api/downloads lists $Sha"
        $fileUrl = "$Site/download/file/" + [Uri]::EscapeDataString($ZipName)
        $req = [Net.HttpWebRequest]::Create($fileUrl)
        $req.Timeout = 30000
        $resp = $req.GetResponse()
        try {
            $hdr = $resp.Headers['x-file-size']
            $stream = $resp.GetResponseStream()
            $buf = New-Object byte[] 65536
            $n = $stream.Read($buf, 0, $buf.Length)
            if ([int]$resp.StatusCode -ne 200 -or $n -le 0 -or $buf[0] -ne 0x50 -or $buf[1] -ne 0x4B) { Fail "$fileUrl did not start a ZIP download" }
            if ($hdr -and [long]$hdr -ne [long](Get-Prop ([pscustomobject]$entry) 'size')) { Fail "$fileUrl reports size $hdr" }
        } finally { $resp.Close() }
        Ok "$fileUrl serves the ZIP"
        if ($NotesRef) {
            # not fatal: the ZIP is out; an old server without the route just shows no notes (deploy the server too)
            try { $rn = Get-Json "$Site/api/release-notes/$Version"; if ([string](Get-Prop $rn 'version') -eq $Version) { Ok "$Site/api/release-notes/$Version serves the notes" } else { Warn "api/release-notes/$Version returned version '$(Get-Prop $rn 'version')'" } }
            catch { Warn "api/release-notes/$Version`: $($_.Exception.Message) (is the server with the release-notes route deployed?)" }
        }
        if ($FullVerify) {
            $tmpDl = Join-Path $env:TEMP "se-verify-$ZipName"
            Info 'downloading the published ZIP to compare its SHA-256 ...'
            Invoke-WebRequest -UseBasicParsing -Uri $fileUrl -OutFile $tmpDl
            $got = Get-Sha256 $tmpDl
            Remove-Item -Force $tmpDl
            if ($got -ne [string](Get-Prop ([pscustomobject]$entry) 'sha256')) { Fail "downloaded ZIP hash $got differs from the manifest" }
            Ok 'downloaded ZIP matches the manifest SHA-256'
        }
    }
    if ($PackageOnly) { $Summary.Add("client: packaged $Zip (not published)") } else { $Summary.Add("client: $ZipName -> $Site/download") }
}

# ------------------------------------------------------------------ 4. git push (optional)
if ($PushBranch -and -not $PackageOnly) {
    Step "git push origin HEAD:$PushBranch"
    if ($DryRun) { Dry "git push origin HEAD:$PushBranch" }
    else {
        & git.exe -C $Repo push origin "HEAD:$PushBranch"
        if ($LASTEXITCODE -ne 0) { Fail 'git push failed' }
        Ok "pushed $Sha"
    }
}

Step ("Done in {0:N0} s{1}" -f ((Get-Date) - $Started).TotalSeconds, $(if ($DryRun) { ' (dry run: nothing changed)' } else { '' }))
foreach ($s in $Summary) { Info $s }
