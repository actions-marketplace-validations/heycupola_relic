const REPO = "heycupola/relic";

// Runs via `irm ... | iex` inside the caller's session, so it must never call
// `exit` (that would close their terminal). Errors are thrown instead.
const INSTALL_SCRIPT = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Install-Relic {
  $Repo = "${REPO}"
  $InstallDir = if ($env:RELIC_INSTALL_DIR) { $env:RELIC_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".relic" }
  $BinDir = Join-Path $InstallDir "bin"

  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $Arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($Arch) {
    "AMD64" { }
    "ARM64" { Write-Host "  Note: installing the x64 build, which runs under Windows emulation on ARM64." }
    default { throw "unsupported architecture: $Arch" }
  }
  $Target = "win32-x64"

  $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "relic-installer" }
  $Version = $Release.tag_name
  if (-not $Version) { throw "could not determine latest version" }

  Write-Host ""
  Write-Host "  Installing relic $Version ($Target)"
  Write-Host ""

  $Archive = "relic-$Target.zip"
  $Url = "https://github.com/$Repo/releases/download/$Version/$Archive"
  $TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("relic-install-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

  try {
    Write-Host -NoNewline "  Downloading..."
    try {
      Invoke-WebRequest -Uri $Url -OutFile (Join-Path $TmpDir $Archive) -UseBasicParsing
    } catch {
      throw "download failed. Check that $Target is supported at https://github.com/$Repo/releases"
    }
    Write-Host " done"

    Write-Host -NoNewline "  Extracting..."
    $Staging = Join-Path $TmpDir "staging"
    Expand-Archive -Path (Join-Path $TmpDir $Archive) -DestinationPath $Staging -Force
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

    Get-ChildItem -Path $BinDir -Filter "*.old" -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue

    foreach ($File in Get-ChildItem -Path $Staging -File) {
      $Destination = Join-Path $BinDir $File.Name
      if (Test-Path $Destination) {
        # A running relic.exe (e.g. during 'relic upgrade') cannot be overwritten, but it can be renamed.
        try {
          Remove-Item -Force $Destination
        } catch {
          Move-Item -Force $Destination "$Destination.old"
        }
      }
      Move-Item -Force $File.FullName $Destination
    }
    Write-Host " done"
  } finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
  }

  Add-RelicToPath $BinDir

  Write-Host ""
  Write-Host "  relic $Version installed successfully!"
  Write-Host "  Run 'relic login' to get started."
  Write-Host ""
}

function Add-RelicToPath([string] $Dir) {
  $Key = Get-Item -Path "HKCU:\\Environment"
  $UserPath = $Key.GetValue("Path", "", "DoNotExpandEnvironmentNames")
  $Entries = @($UserPath -split ";" | Where-Object { $_ })

  if ($Entries -notcontains $Dir) {
    $NewPath = (@($Dir) + $Entries) -join ";"
    Set-ItemProperty -Path "HKCU:\\Environment" -Name "Path" -Value $NewPath -Type ExpandString
    # Writing a user variable through .NET broadcasts WM_SETTINGCHANGE so new terminals see the PATH change.
    [Environment]::SetEnvironmentVariable("RELIC_INSTALLER_REFRESH", "1", "User")
    [Environment]::SetEnvironmentVariable("RELIC_INSTALLER_REFRESH", $null, "User")
    Write-Host "  Added $Dir to your user PATH"
    Write-Host "  Restart your terminal to use relic everywhere."
  }

  if (($env:Path -split ";") -notcontains $Dir) {
    $env:Path = "$Dir;$env:Path"
  }
}

try {
  Install-Relic
} catch {
  Write-Host ""
  Write-Host "  error: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
}
`;

export async function GET() {
  return new Response(INSTALL_SCRIPT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
