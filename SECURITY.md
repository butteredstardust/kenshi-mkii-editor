# Security Policy

Kenshi MKII Editor parses and overwrites local game saves. Please report
vulnerabilities privately and do not attach save directories, backups, cached
game data, personal paths, or other users' information.

## Supported versions

Security fixes are applied to the latest published release and current `main`.
Older releases are not maintained unless explicitly stated.

## Reporting a vulnerability

Do not open a public issue. Contact the maintainer privately using the contact
methods on the
[maintainer's GitHub profile](https://github.com/butteredstardust). If no private
contact method is available, open a public issue requesting a private channel
without including vulnerability details.

Include the affected version and Kenshi version, prerequisites, minimal
reproduction steps, impact, and a suggested mitigation if known. Use synthetic
or redacted artifacts only. You should receive an acknowledgment within 10
business days; the maintainer will validate the report and coordinate
remediation and disclosure.

## Scope

In scope are vulnerabilities in the loopback web application, CSRF and input
validation, binary parsing and serialization, path and process handling, staged
mutation and rollback logic, backup restore behavior, installer/build scripts,
and official dependencies.

Reports about gameplay cheating, proprietary game services, or issues that
require deliberately exposing the loopback service are generally out of scope.
Third-party dependency vulnerabilities should also be reported upstream; notify
this project when an official supported build is affected.

## Safety invariants

Security fixes must not weaken the loopback-only bind, game-running gate,
whole-directory backup, staged writes, complete parse checks, byte-identical
round trip, before/after hashing, or automatic rollback. Test only on systems
and saves you own or are authorized to use.
