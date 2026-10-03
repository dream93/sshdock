# SSHDock

SSHDock is an open-source visual SSH desktop client built with Electron. It supports:

- SSH password login
- SSH private key login
- Saving connection profiles, including credentials protected with Electron `safeStorage` when OS encryption is available
- Interactive shell sessions
- macOS `.pkg` packaging
- Windows NSIS and portable packaging

## Run locally

```bash
npm install
npm start
```

## Build packages

macOS `.pkg`:

```bash
npm run dist:mac
```

Windows installer and portable package:

```bash
npm run dist:win
```

Cross-platform packaging generally needs to run on the target OS for best results, especially Windows code signing and macOS notarization.

## Native migration

The native implementation uses SwiftUI/AppKit on macOS, C#/WinUI 3 on Windows,
and a shared Rust session core. It includes SSH password/private key login,
host key verification, saved connection profiles, remote terminals, SFTP,
Linux server statistics, and local terminals. Credentials are stored in macOS
Keychain or Windows Credential Manager. Existing Electron connection metadata
can be imported; saved passwords and key passphrases must be entered again.
Release installers and the remaining platform interaction checks are still in
progress. The Electron application continues to work alongside the native app.

See [native development and acceptance guide](native/README.md) for build commands,
the shared interface, supported architectures, and the migration plan.
