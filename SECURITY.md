# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue, PR, or
discussion for anything exploitable.

- **Preferred:** open a
  [private security advisory](https://github.com/huythanhlam/whatshappenin/security/advisories/new)
  on this repository. It is private to the maintainers and needs no mailbox setup.
- By email: **security@whatitdo.app**

Please include what you can: affected URL or file, reproduction steps, and what
an attacker could get. A proof-of-concept helps but is not required.

## What to expect

- Acknowledgement within **3 business days**.
- An assessment and a fix timeline within **10 business days**.
- Credit in the fix notes if you would like it — tell us how to name you.

Please give us a reasonable window to ship a fix before disclosing publicly.

## Scope

This repository and the production deployment at **whatitdo.app**.

Out of scope: findings from automated scanners with no demonstrated impact,
missing hardening headers with no exploit path, denial of service through sheer
volume, and social engineering of the maintainers or their users.

## Supported versions

This is a continuously deployed application; only the currently deployed
`main` is supported. There are no maintained release branches.
