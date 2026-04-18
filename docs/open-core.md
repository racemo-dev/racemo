# Racemo Open Core Model

Racemo uses an open-core model.
This repository contains the desktop client and local runtime.
Some remote infrastructure is operated as a managed service and is not included here.

## What Is Open-Source

The following are part of this repository and available under the repository license:

- Desktop client UI
- Tauri shell and local Rust command layer
- Local `racemo-server` runtime used for PTY and session management
- Local-first terminal, editor, git, and session persistence features
- Client-side remote session integration and protocol usage
- Public docs describing boundaries, trust model, and protocol shape

## What Is Not In This Repository

The following are not included here:

- Production signaling relay implementation
- Managed billing and subscription backend
- TURN/relay infrastructure and abuse controls
- Internal deployment, operations, and admin tooling for hosted services

## Why The Boundary Exists

Racemo's managed service needs operational controls that do not map cleanly to a
public client repository:

- Abuse prevention and quota enforcement
- Secret management and hosted environment configuration
- Reliability work specific to running a shared internet-facing service
- Billing and account administration for the managed offering

The open-source part should remain inspectable and useful on its own.
The managed part exists because operating shared remote infrastructure is a
different problem from shipping a desktop client.

## What "Remote" Means In Practice

Remote session setup uses a managed signaling relay.
That relay helps peers authenticate and exchange the metadata needed to establish
a WebRTC connection.

Racemo is designed so that terminal traffic flows over the peer-to-peer data
channel after setup rather than through the signaling relay.

Important:

- The remote peer is treated as trusted.
- Remote hosting is not a sandbox.
- Host-side filesystem access and command execution still happen on the host machine.

See [../SECURITY.md](../SECURITY.md) for the detailed trust model.

## Self-Hosting

This repository does not currently provide an officially supported self-hosting
package for Racemo's managed remote service.

That means:

- You can inspect the client-side remote behavior here.
- You should not assume the hosted backend is reproducible from this repository alone.
- Compatibility details exposed publicly are documented in [PROTOCOL.md](PROTOCOL.md).

If Racemo later publishes a supported self-hosting story, it should be treated as
a separate deliverable with its own documentation and support expectations.

## Public Contract

For contributors and users, the public contract is:

- This repo is the source of truth for the desktop client.
- Managed-service behavior may evolve independently as long as the client-facing
  contract remains compatible.
- Security-sensitive hosted internals are not promised as part of this repo.

## Related Documents

- [../README.md](../README.md)
- [architecture.md](architecture.md)
- [PROTOCOL.md](PROTOCOL.md)
- [FAQ.md](FAQ.md)
- [../SECURITY.md](../SECURITY.md)
