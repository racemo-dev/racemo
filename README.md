<p align="center">
  <img src="public/racemo-icon.png" alt="Racemo" width="80" />
</p>

<h1 align="center">Racemo</h1>

<p align="center">
  <strong>Your terminal. Anytime, anywhere.</strong><br/>
  A cross-platform GUI terminal multiplexer with persistent sessions and secure remote access.
</p>

<p align="center">
  <a href="https://github.com/racemo-dev/racemo/releases/latest">Download</a> ·
  <a href="docs/FEATURES.md">Features</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License" />
  <img src="https://img.shields.io/badge/version-0.0.5-violet" alt="Version" />
  <img src="https://img.shields.io/badge/status-Developer%20Preview-orange" alt="Status" />
  <img src="https://img.shields.io/badge/built%20with-Rust%20%2B%20Tauri-orange" alt="Built with" />
</p>

---

## What is Racemo?

Racemo keeps your terminal sessions alive and passes them seamlessly across Windows, macOS, and Linux. No more losing your workspace after a reboot. No more memorizing tmux shortcuts.

### Three core values

**Easy Terminal** — Split, resize, and rearrange panels with drag and drop. Zero config, full ANSI/Unicode/24-bit color support out of the box.

**Persistent Sessions** — A background Rust daemon keeps your PTY sessions alive independently of the GUI. Close the app, reopen it — everything is exactly where you left it. Fully native on Windows.

**Remote Access** — Connect from your MacBook to your Windows desktop via secure WebRTC P2P. No port forwarding, no SSH keys. End-to-end encrypted.

## Install

### macOS

```bash
brew tap racemo-dev/tap && brew install --cask racemo
```

Or download `Racemo_x.x.x_Mac.dmg` from [Releases](https://github.com/racemo-dev/racemo/releases/latest).

### Windows

Download `Racemo_x.x.x_Windows_x64-setup.exe` from [Releases](https://github.com/racemo-dev/racemo/releases/latest).

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/racemo-dev/racemo/main/install.sh | sh
```

Or download the AppImage manually from [Releases](https://github.com/racemo-dev/racemo/releases/latest).

| Platform | File |
|----------|------|
| macOS (Universal) | `Racemo_x.x.x_Mac.dmg` |
| Windows | `Racemo_x.x.x_Windows_x64-setup.exe` |
| Linux x64 | `Racemo_x.x.x_Linux_x64.AppImage` |
| Linux ARM64 | `Racemo_x.x.x_Linux_aarch64.AppImage` |

All platforms include automatic updates.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop App | [Tauri v2](https://tauri.app) |
| Frontend | React 19, TypeScript, Tailwind CSS v4 |
| Terminal | [xterm.js](https://xtermjs.org) v6 (WebGL) |
| Backend | Rust, [portable-pty](https://docs.rs/portable-pty), Tokio |
| IPC | MessagePack over Unix Socket / Named Pipe |
| Remote | WebRTC (P2P), Protobuf, DTLS/SCTP |
| State | Zustand |

## Architecture

```
┌─ Tauri Client (React + TypeScript) ─────────────┐
│  xterm.js terminals  ·  GUI panel layout (binary │
│  tree)  ·  Sidebar (sessions, SSH, files)        │
└──────────────────────────────────────────────────┘
              ↕  IPC (MessagePack)
         Unix Socket / Named Pipe
┌──────────────────────────────────────────────────┐
│  Racemo Server (Rust Daemon)                     │
│  PTY manager  ·  Session persistence  ·  WebRTC  │
│  host  ·  Built-in CLI tools                     │
└──────────────────────────────────────────────────┘
              ↕  Shell
         bash / zsh / pwsh / ssh
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Project Structure

```
racemo/
├── src/                        # React + TypeScript frontend
│   ├── components/
│   │   ├── Auth/               # Authentication
│   │   ├── Billing/            # Subscription & billing
│   │   ├── CommandPalette/     # Ctrl+Shift+P command palette
│   │   ├── Editor/             # Built-in editor
│   │   ├── Layout/             # Panel layout engine
│   │   ├── Sidebar/            # Session & SSH sidebar
│   │   ├── Terminal/           # xterm.js terminal wrapper
│   │   └── ...
│   ├── lib/                    # Utilities
│   │   ├── completionEngine.ts # Smart autocomplete
│   │   ├── linkDetector.ts     # Clickable links/paths
│   │   ├── ptyOutputBuffer.ts  # PTY output processing
│   │   ├── remoteWebrtc.ts     # WebRTC client
│   │   ├── secretDetector.ts   # API key masking
│   │   └── ...
│   └── stores/                 # Zustand state management
├── src-tauri/                  # Tauri + Rust backend
│   └── src/
│       ├── commands/           # Tauri IPC commands
│       ├── ipc/                # Named Pipe / Unix Socket server
│       ├── remote/             # WebRTC host, pairing, signaling
│       ├── bin/
│       │   └── racemo_server.rs # Background daemon
│       ├── layout.rs           # Binary tree panel layout
│       ├── session.rs          # Session management
│       ├── persistence.rs      # Session restore
│       └── ...
├── signaling-server/           # WebRTC signaling server (Rust)
├── web-client/                 # Browser-based remote client
├── proto/                      # Protobuf definitions
├── docs/                       # Documentation
└── tests/                      # Playwright E2E tests
```

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs) 1.75+
- Platform-specific Tauri dependencies ([guide](https://v2.tauri.app/start/prerequisites/))

### Development

```bash
npm install
npm run tauri dev
```

### Testing

```bash
# Rust backend tests
cd src-tauri && cargo test

# Signaling server tests
cd signaling-server && cargo test

# Lint
cargo clippy

# Frontend build check
npm run build

# E2E tests
npx playwright test
```


## FAQ

### Windows SmartScreen Warning

You may see a Windows SmartScreen warning when installing Racemo. This is normal for newly released applications that haven't yet accumulated a large number of downloads.

**To proceed with installation:**
1. Click **"More info"**
2. Click **"Run anyway"**

The installer is digitally signed with a verified Certum Code Signing (OV) certificate. You can confirm the signature by right-clicking the installer → **Properties** → **Digital Signatures** tab.

### Why does SmartScreen show a warning?

Windows SmartScreen builds reputation based on download volume. New applications — even those with valid code signing certificates — may trigger a warning until enough users have downloaded and installed them. This is expected behavior and not a security issue.

### How can I verify the installer is authentic?

Right-click the `.exe` file → **Properties** → **Digital Signatures** tab. You should see **"Racemo"** listed as the signer with a valid certificate issued by Certum.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[Apache License 2.0](LICENSE)

---

<p align="center">
  <sub>Built with Rust + Tauri + xterm.js</sub>
</p>
