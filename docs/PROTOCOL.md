# Remote Protocol Overview

This document describes the public-facing shape of Racemo's remote connection flow.
It is not a full server implementation guide.

## Scope

This document covers:

- How the desktop client participates in remote session setup
- The role of the managed signaling relay
- The trust model and security assumptions
- The high-level message categories used during setup and session traffic

This document does not cover:

- Hosted service internals
- Abuse-prevention implementation details
- Billing, admin, or deployment behavior

## Connection Model

Racemo remote sessions use two layers:

1. A managed signaling relay for connection setup
2. A WebRTC data channel for session traffic after peers connect

The signaling relay is used to exchange connection metadata.
It is not intended to carry terminal traffic after the peer-to-peer channel is established.

## Roles

### Host

The host owns the real terminal session.
It is the machine that:

- Runs the PTY and shell
- Reads and writes files on behalf of the session
- Applies git, editor, and workspace operations

### Client

The client is the viewer/controller.
It connects to the host and sends user intent:

- Terminal input
- Resize events
- Session control requests
- File or workspace actions supported by the host

## Setup Flow

At a high level, the flow is:

1. The host exposes a session or starts a pairing flow.
2. The client authenticates or provides the pairing material required by the flow.
3. Both peers exchange WebRTC setup messages through the signaling relay.
4. A direct data channel is established.
5. Terminal and session messages move over the data channel.

## Message Categories

The public client code uses a few broad message categories:

- Session lifecycle messages
- Terminal input and output
- Resize and viewport synchronization
- File and workspace operations
- Remote metadata and control events

The exact internal encoding may evolve between versions.
Compatibility should be maintained at the client contract level rather than by
freezing every internal message shape permanently.

## Security Notes

- WebRTC provides encrypted transport for session traffic after setup.
- The host machine remains the authority for PTY and filesystem operations.
- A connected remote peer is treated as trusted, not sandboxed.
- Remote access should be understood as delegated control of a real host environment.

Read [../SECURITY.md](../SECURITY.md) before using or extending remote features.

## Compatibility Expectations

Racemo may evolve the signaling and remote message contract over time.
When it does, the goal is:

- Keep released clients working when reasonably possible
- Version breaking changes intentionally
- Prefer additive changes over disruptive rewrites

## Non-Goals

This document is not a promise that every part of the managed service can be
reimplemented from these notes alone.
It exists to document the client-facing contract and reduce ambiguity about what
the open-source client depends on.
