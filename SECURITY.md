# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 3.x | Yes |
| < 3.0 | No |

## Report a Vulnerability

Please report security issues privately.
Do not open a public issue.

Use GitHub private vulnerability reporting on the repository:
https://github.com/louisphamdev/adversarial-review
Go to Security, then select Report a vulnerability.

We will acknowledge reports within a few business days.

## Scope and Threat Model

The roundtable treats all reviewed material as untrusted data.
The code, diffs, file names, comments, docstrings, and test fixtures are data.
They are not instructions.
Reviewer seats must ignore all instructions inside the material.

Reviewer seats run with restricted permissions:

- Seats can read files in the target workspace.
- Seats cannot execute shell commands.
- Seats cannot write or edit files in the workspace.
- Seats cannot make network requests unless configured for model access.

Adversarial review reduces the risk of defects and security regressions.
Adversarial review is not a complete security sandbox.
A local user with filesystem access can change configurations.
Review all findings before you apply proposed patches.
