# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 2.1.x | Yes |
| 2.0.x | Yes |
| < 2.0 | No |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting on the repository:
[github.com/louisphamdev/adversarial-review](https://github.com/louisphamdev/adversarial-review)
→ **Security** → **Report a vulnerability**.

We aim to acknowledge reports within a few business days.

## Scope and threat model

This tool is a **review gate and quality guard, not a security sandbox or a DLP
(data loss prevention) system.** It reduces the chance that significant code
changes finish without an adversarial review; it does **not** restrict what code
a host agent executes, and a local user with filesystem access can disable it.

Before reporting, please read the [Residual Risks](./README.md#residual-risks)
section of the README, which documents the tool's known limitations (host hook
honesty, wrapper-mode boundaries, best-effort secret scanning, external-provider
disclosure, and local-bypass). Findings already covered there are by design, not
vulnerabilities.
