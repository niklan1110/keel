# Security policy

Keel holds people's data and runs on their own machines, so security reports
are welcome and handled first.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it
privately instead: on this repository, open the **Security** tab and choose
**Report a vulnerability** (GitHub's private vulnerability reporting). Only the
maintainers see the report.

Helpful to include:

- what an attacker can do, and what they need first (network position, an
  account, a setting);
- the Keel version (`./keel version`, or Studio's project settings) and how it
  is installed (installer, ZimaOS, from source);
- steps or a small proof of concept. Please test against your own install only.

What happens next:

- We confirm we got the report within **3 days**.
- We tell you whether we can reproduce it, and how serious we think it is,
  within **10 days**.
- We fix it in a new release, credit you in the release notes if you like,
  and publish a GitHub security advisory once people can update.

## Supported versions

Keel is young, so only the newest release gets security fixes. Update with
`./keel update` (see [Updating](website/self-hosting/updating.md)).

| Version | Security fixes |
|---|---|
| Newest release (`latest`) | Yes |
| Older releases | No; update to the newest |
| `edge` builds of the default branch | Fixed in the next build, not supported for production |

Once Keel reaches 1.0, the previous minor version will get security fixes for
three months after a new one comes out.

## Checking what you run

Release images are signed with cosign (keyless, through GitHub), carry an SBOM
and build provenance, and each release's installer has a SHA-256 checksum and a
build attestation. [Updating](website/self-hosting/updating.md#check-what-you-run)
shows how to verify them.
