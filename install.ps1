# Legends SEO Dungeon installer for Windows
# Installs the bundled SEO skill suite for Codex.

$ErrorActionPreference = "Stop"

function Resolve-Python {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) { return @{ Exe = "py"; Args = @("-3") } }
    $python3 = Get-Command python3 -ErrorAction SilentlyContinue
    if ($python3) { return @{ Exe = "python3"; Args = @() } }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        $source = [string]$python.Source
        if ($source -match "Microsoft Store|WindowsApps|App execution alias|was not found") {
            return $null
        }
        return @{ Exe = "python"; Args = @() }
    }
    return $null
}

function Copy-DirContents {
    param([string]$Source, [string]$Target)
    if (-not (Test-Path $Source)) { return }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Copy-Item -Path (Join-Path $Source "*") -Destination $Target -Recurse -Force
}

function Get-SourceDir {
    $scriptDir = Split-Path -Parent $PSCommandPath
    if (Test-Path (Join-Path $scriptDir "skills\seo\SKILL.md")) {
        return $scriptDir
    }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git is required for remote install."
    }

    $repo = if ($env:SEO_DUNGEON_REPO) { $env:SEO_DUNGEON_REPO } else { "https://github.com/avalonreset/legends-seo-dungeon" }
    $ref = if ($env:SEO_DUNGEON_REF) { $env:SEO_DUNGEON_REF } else { "main" }
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $checkout = Join-Path $tempDir "legends-seo-dungeon"
    Write-Host "[INFO] Downloading Legends SEO Dungeon ($ref)..." -ForegroundColor Yellow
    git clone --depth 1 --branch $ref $repo $checkout
    if ($LASTEXITCODE -ne 0) { throw "Could not download the requested repository and ref." }
    return $checkout
}

function Install-PythonDeps {
    param([string]$SkillDir, [hashtable]$Python)
    if ($env:SEO_DUNGEON_SKIP_DEPS -eq "1") {
        Write-Host "[INFO] Skipping Python dependency install." -ForegroundColor Yellow
        return
    }
    $runtimeScript = Join-Path $SkillDir "scripts\runtime.py"
    & $Python.Exe @($Python.Args + @($runtimeScript, "setup"))
    if ($LASTEXITCODE -notin @(0, 10)) { throw "Managed Python runtime setup failed." }
    if ($LASTEXITCODE -eq 10) {
        Write-Host "[WARN] Core runtime ready; Chromium setup is incomplete." -ForegroundColor Yellow
    }
}

function Install-Codex {
    param([string]$SourceDir, [hashtable]$Python)
    $codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
    $skillsRoot = Join-Path $codexRoot "skills"
    $agentsRoot = Join-Path $codexRoot "agents"
    $skillDir = Join-Path $skillsRoot "seo"

    Write-Host "[INFO] Installing Codex skill tree to $skillsRoot" -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $skillsRoot, $agentsRoot | Out-Null
    Get-ChildItem -Path (Join-Path $SourceDir "skills") -Directory | ForEach-Object {
        Copy-DirContents $_.FullName (Join-Path $skillsRoot $_.Name)
    }
    Copy-Item -Path (Join-Path $SourceDir "agents-codex\*.toml") -Destination $agentsRoot -Force -ErrorAction SilentlyContinue
    foreach ($name in @("scripts", "schema", "pdf", "hooks", "extensions", "data", "bin")) {
        Copy-DirContents (Join-Path $SourceDir $name) (Join-Path $skillDir $name)
    }
    Copy-Item -Path (Join-Path $SourceDir "requirements.txt") -Destination (Join-Path $skillDir "requirements.txt") -Force -ErrorAction SilentlyContinue
    foreach ($name in @("runtime-plugin.json", "LICENSE-CLAUDE-SEO", "LICENSE", "THIRD-PARTY-NOTICES.md")) {
        Copy-Item -LiteralPath (Join-Path $SourceDir $name) -Destination (Join-Path $skillDir $name) -Force
    }
    & $Python.Exe @($Python.Args + @((Join-Path $SourceDir "scripts\install_runtime_docs.py"), "--skills-root", $skillsRoot, "--agents-root", $agentsRoot))
    if ($LASTEXITCODE -ne 0) { throw "Runtime prompt binding failed." }
    Install-PythonDeps $skillDir $Python
}

$python = Resolve-Python
if ($null -eq $python) { throw "Python 3 is required." }
$versionOk = & $python.Exe @($python.Args + @("-c", "import sys; print(1 if sys.version_info >= (3, 11) else 0)"))
if ($versionOk -ne "1") { throw "Python 3.11+ is required." }
$sourceDir = Get-SourceDir

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Legends SEO Dungeon - Installer" -ForegroundColor Cyan
Write-Host "  Codex Skill Suite" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Install-Codex $sourceDir $python

Write-Host "[OK] Legends SEO Dungeon skills installed for Codex." -ForegroundColor Green
Write-Host "The repo-local AGENTS.md keeps the skill suite portable for compatible terminal agents." -ForegroundColor Cyan
