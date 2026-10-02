param(
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [switch]$RunSmokeTests
)
$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path $PSScriptRoot -Parent
$rustTarget = if ($Architecture -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
$platform = if ($Architecture -eq 'arm64') { 'ARM64' } else { 'x64' }
$profile = if ($Configuration -eq 'Release') { 'release' } else { 'debug' }
$outputDirectory = Join-Path $PSScriptRoot "artifacts/$Architecture"

rustup target add $rustTarget
if ($LASTEXITCODE -ne 0) { throw 'Unable to install the Rust target' }
$cargoArguments = @('build', '--locked', '--manifest-path', "$nativeRoot/core/Cargo.toml", '--target', $rustTarget)
if ($Configuration -eq 'Release') { $cargoArguments += '--release' }
& cargo @cargoArguments
if ($LASTEXITCODE -ne 0) { throw 'Native core build failed' }

dotnet publish "$PSScriptRoot/SSHDock.Native/SSHDock.Native.csproj" `
    --configuration $Configuration --runtime "win-$Architecture" --self-contained true `
    -p:Platform=$platform -p:WindowsAppSDKSelfContained=true -o $outputDirectory
if ($LASTEXITCODE -ne 0) { throw 'WinUI application build failed' }
if (-not (Test-Path (Join-Path $outputDirectory 'SSHDock.Native.pri'))) {
    throw 'WinUI application SSHDock.Native.pri was not published; the native XAML controls cannot load their theme resources'
}
Copy-Item "$nativeRoot/core/target/$rustTarget/$profile/sshdock_core.dll" $outputDirectory -Force

if ($RunSmokeTests) {
    $previousCoreLibrary = [Environment]::GetEnvironmentVariable('SSHDOCK_CORE_LIBRARY', 'Process')
    $env:SSHDOCK_CORE_LIBRARY = Join-Path $outputDirectory 'sshdock_core.dll'
    try {
        dotnet run --project "$PSScriptRoot/CoreSmokeTest/CoreSmokeTest.csproj" --configuration $Configuration --runtime "win-$Architecture"
        if ($LASTEXITCODE -ne 0) { throw 'Managed/native ABI smoke test failed' }
    } finally { [Environment]::SetEnvironmentVariable('SSHDOCK_CORE_LIBRARY', $previousCoreLibrary, 'Process') }
}
Write-Host "Built SSHDock: $outputDirectory/SSHDock.Native.exe"
