# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Racemo, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@racemo.dev**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix and disclosure**: Coordinated with reporter

## Scope

- Racemo desktop client (Tauri app)
- WebRTC P2P connections
- IPC protocol

> The signaling relay server is a closed-source hosted service and is not covered by this repository's security scope. To report issues related to the hosted service, use the same email above.

## Out of Scope

- Vulnerabilities in upstream dependencies (report to the respective project)
- Social engineering attacks
- Denial of service attacks against the signaling server

## Remote Host Trust Model

Racemo's remote hosting (WebRTC pairing or account-based) assumes the remote peer is a
**trusted user**: the person you explicitly share a pairing code or account with. There is
no sandbox between remote clients and the host machine beyond the path-level guards below.

### Path access guards

Remote file operations (explorer, git, recent directories) go through `validate_remote_path()`
in [src-tauri/src/remote/server_host.rs](src-tauri/src/remote/server_host.rs).

| Platform | Policy |
|---|---|
| **Unix (macOS / Linux)** | Remote peers may only read paths under `$HOME`. |
| **Windows** | Remote peers may access all drives on the host. This is an intentional policy: Windows users commonly work from non-system drives (e.g. `D:\work`), and restricting to `%USERPROFILE%` would break realistic workflows. |

### Recommendations

- **Only pair with people you trust.** Sharing a pairing code or account with an
  untrusted party is equivalent to handing them filesystem access within the guard above.
- Expire or rotate pairing codes promptly if you suspect disclosure.
- On Windows, avoid hosting while sensitive non-home data is on the same machine
  (e.g. personal finance spreadsheets on `D:\`).

### Future work

- Stricter Windows path policy (opt-in drive allowlist) — tracked for a future release.
- Per-session file-access capability prompts — tracked for a future release.
