# FAQ

## Is Racemo open-source?

The desktop client repository is open-source.
Racemo's managed remote infrastructure is not included in this repository.

See [open-core.md](open-core.md).

## Why is the server side not in this repo?

The managed remote service includes operational concerns that are different from
the desktop client:

- secret management
- abuse prevention
- hosted reliability work
- billing and account administration

Racemo keeps the client inspectable while operating the shared service separately.

## Can I use Racemo without the hosted remote service?

Yes.
The local desktop client and local session features are the primary open-source
part of the project.

Remote setup, however, depends on Racemo's managed signaling service.

## Is remote access end-to-end encrypted?

After setup, session traffic is intended to flow over an encrypted WebRTC data channel.
The signaling relay is used for connection setup, not as the normal path for terminal traffic.

## Does remote access sandbox the other user?

No.
The remote peer is treated as trusted.
Remote hosting should be understood as giving another device or user control over
resources on the host machine within Racemo's host-side policies.

See [../SECURITY.md](../SECURITY.md).

## Why is the Windows host policy called out in the security docs?

Because the current remote host path policy is stronger on Unix-like systems than
on Windows.
On Windows, real-world workflows often use non-system drives, which creates a
different tradeoff.

That policy is documented so users can evaluate the risk explicitly before using
remote hosting.

## Can I self-host the remote backend?

This repository does not currently provide an officially supported self-hosting
package for the managed remote service.

## Where should I start if I want to contribute?

Start with:

- [../README.md](../README.md)
- [architecture.md](architecture.md)
- [../CONTRIBUTING.md](../CONTRIBUTING.md)
- [PROTOCOL.md](PROTOCOL.md)

## Where should I report security issues?

Use the process documented in [../SECURITY.md](../SECURITY.md).
