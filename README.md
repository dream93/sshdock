# SSHDock

SSHDock is an open-source visual SSH desktop client built with Electron. It supports:

- SSH password login
- SSH private key login
- Saving connection profiles without saving passwords
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
