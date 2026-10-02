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

The native implementation is being developed in stages with SwiftUI/AppKit on macOS,
C#/WinUI 3 on Windows, and a shared Rust session core. The first milestone provides
local terminals and validates the native terminal controls and C ABI. SSH, SFTP,
connection import, and release installers remain later milestones; the Electron
application continues to provide those features.

See [native development and acceptance guide](native/README.md) for build commands,
the shared interface, supported architectures, and the migration plan.
