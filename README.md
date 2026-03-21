# Racemo

A GPU-accelerated terminal multiplexer built with Tauri, React, and xterm.js.

## Download

Get the latest version from the [Releases](https://github.com/racemo-dev/racemo-client/releases) page.

| Platform | File |
|----------|------|
| Windows (installer) | `Racemo_x.x.x_x64-setup.exe` |
| Windows (MSI) | `Racemo_x.x.x_x64.msi` |
| macOS (DMG) | `Racemo_x.x.x_aarch64.dmg` |

## Windows SmartScreen Warning

You may see a Windows SmartScreen warning when installing Racemo. This is normal for newly released applications that haven't yet accumulated a large number of downloads.

**To proceed with installation:**
1. Click **"More info"**
2. Click **"Run anyway"**

The installer is digitally signed with a verified Certum Code Signing (OV) certificate. You can confirm the signature by right-clicking the installer → **Properties** → **Digital Signatures** tab.

## FAQ

### Why does SmartScreen show a warning?

Windows SmartScreen builds reputation based on download volume. New applications — even those with valid code signing certificates — may trigger a warning until enough users have downloaded and installed them. This is expected behavior and not a security issue.

### How can I verify the installer is authentic?

Right-click the `.exe` file → **Properties** → **Digital Signatures** tab. You should see **"Racemo"** listed as the signer with a valid certificate issued by Certum.

## License

[Apache License 2.0](LICENSE)
