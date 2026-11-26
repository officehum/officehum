# Security

## Report a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting on
this repository: open the **Security** tab and choose **Report a vulnerability**. Only the
maintainers can see the report.

Do not open a public issue, pull request or discussion about a vulnerability before it is fixed.

A useful report says which package and version (or commit) is affected, what an attacker can do,
and the steps to reproduce it.

## Scope

In scope: the code in this repository, including the packages under `packages/` and the roles
under `agents/`.

This repository runs no service, so there is no production system to test. Do not test against an
installation someone else runs.

Out of scope: problems in third-party dependencies (report those to the project concerned; tell us
if a package here uses the affected code in a way that makes it exploitable), and the behaviour of
the language models a role calls, unless a role's guardrail (an approval or a limit) fails to hold.
