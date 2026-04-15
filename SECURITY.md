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
