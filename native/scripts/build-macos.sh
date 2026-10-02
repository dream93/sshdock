#!/usr/bin/env bash
set -euo pipefail

native_root="$(cd "$(dirname "$0")/.." && pwd)"
configuration="${1:-release}"
if ! command -v cargo >/dev/null 2>&1 && [[ -x "$HOME/.cargo/bin/cargo" ]]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if [[ "$configuration" != "release" && "$configuration" != "debug" ]]; then
  echo "Usage: $0 [release|debug]" >&2
  exit 2
fi

cargo build --manifest-path "$native_root/core/Cargo.toml" --release --locked
# The native SwiftPM builder copies SwiftTerm's optional Metal shader source.
# This prototype uses its CoreText renderer, so no Metal toolchain is required.
swift build --package-path "$native_root/macos" --build-system native --force-resolved-versions -c "$configuration"
binary_root="$(swift build --package-path "$native_root/macos" --build-system native --force-resolved-versions -c "$configuration" --show-bin-path)"
app_root="$native_root/artifacts/SSHDockNative.app"
mkdir -p "$app_root/Contents/MacOS" "$app_root/Contents/Resources"
cp "$binary_root/SSHDockNative" "$app_root/Contents/MacOS/SSHDockNative"
cp "$native_root/macos/Info.plist" "$app_root/Contents/Info.plist"

# Keep optional dependency resources in the conventional signed bundle layout.
# SwiftTerm's Metal renderer is disabled; its shader is not loaded by CoreText.
for resource_bundle in "$binary_root"/*.bundle; do
  if [[ -d "$resource_bundle" ]]; then
    bundle_name="$(basename "$resource_bundle")"
    rm -rf "$app_root/$bundle_name"
    rm -rf "$app_root/Contents/Resources/$bundle_name"
    cp -R "$resource_bundle" "$app_root/Contents/Resources/$bundle_name"
  fi
done
codesign --force --sign - "$app_root"
echo "Built: $app_root"
