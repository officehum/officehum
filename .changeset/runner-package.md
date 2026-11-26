---
"@officehum/runner": minor
"@officehum/sdk": minor
---

New package `@officehum/runner`: runs one role package on a Pi Durable harness. It holds the harness
adapter, `loadRole`, `openRoleRun`, the local calendar, the eval judge and cost helpers, key-error
redaction and the scripted model (`@officehum/runner/testing`). The SDK now exports `COMPANY_FACTS`,
the path of the company record in a role package.
