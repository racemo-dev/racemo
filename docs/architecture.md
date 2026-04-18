# Racemo Architecture

This document describes the open-source desktop client repository.
It focuses on the parts available in this repo and the runtime boundaries
between local code, the local daemon, and Racemo's managed remote service.

## High-Level Overview

```text
React UI (src/)
  |
  v
Tauri shell and command bridge (src-tauri/)
  |
  +--> Local IPC -> racemo-server sidecar -> PTY / shell / session state
  |
  +--> Remote mode -> WebRTC data channel -> another Racemo host
                      ^
                      |
                Managed signaling relay
                for session setup only
```

## Main Components

### React frontend

The frontend lives in [../src/](../src/).
It is responsible for:

- Terminal rendering with `xterm.js`
- Pane, tab, sidebar, and settings UI
- Editor, diff, and git-facing workflows
- Local and remote session orchestration through the Tauri bridge

### Tauri shell

The desktop shell lives in [../src-tauri/](../src-tauri/).
It is responsible for:

- Native windowing and OS integrations
- Invoking Rust commands from the frontend
- Spawning and talking to the local `racemo-server` sidecar
- Packaging, updater integration, and platform-specific behavior

### Local daemon: `racemo-server`

`racemo-server` is the local runtime that owns terminal execution.
It is responsible for:

- PTY lifecycle management
- Session persistence and output buffering
- Local IPC handling
- Acting as the host-side endpoint for remote sessions

### Managed remote service

Remote session setup depends on a managed signaling relay operated by Racemo.
That service is not part of this repository.

Its role is intentionally narrow:

- Exchange connection metadata needed for WebRTC setup
- Authenticate hosted remote flows
- Help peers discover each other

After a connection is established, terminal traffic is intended to flow over the
peer-to-peer WebRTC data channel rather than through the relay.

See [open-core.md](open-core.md) and [PROTOCOL.md](PROTOCOL.md).

## Data Flow

### Local session

1. The user types into the terminal UI.
2. The frontend sends input through the Tauri bridge.
3. The Rust layer forwards it to `racemo-server`.
4. `racemo-server` writes to the PTY.
5. PTY output is buffered and streamed back to the frontend for rendering.

### Remote session

1. A host creates or exposes a terminal session.
2. The client and host use the managed relay to exchange WebRTC setup messages.
3. Once connected, terminal messages are exchanged over WebRTC.
4. The host-side `racemo-server` continues to own the real PTY and filesystem access.

## Security Model

- Local IPC relies on OS-level local process boundaries and filesystem permissions.
- Remote transport uses WebRTC encryption for session traffic after setup.
- The remote peer is treated as trusted by design; Racemo is not a sandbox.
- Host-side filesystem and command execution still happen on the host machine.

Read [../SECURITY.md](../SECURITY.md) before using remote features.

## Repository Layout

| Path | Role |
|---|---|
| [../src/](../src/) | React frontend and UI state |
| [../src-tauri/](../src-tauri/) | Tauri shell, Rust commands, local server integration |
| [../public/](../public/) | Static assets copied into the app bundle |
| [../assets/](../assets/) | Screenshots and README assets |
| [../tests/](../tests/) | End-to-end tests |
| [./](.) | Public documentation for protocol and FAQs |

## Non-Goals For This Repository

This repository does not contain:

- The production signaling relay implementation
- Managed billing or subscription backend code
- TURN or relay infrastructure
- Internal operations and deployment tooling for hosted services

Those boundaries are intentional and documented in [open-core.md](open-core.md).
