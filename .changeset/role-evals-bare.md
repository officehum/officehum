---
"@officehum/role-factory": minor
"@officehum/cli": minor
"@officehum/bookkeeper": patch
"@officehum/finance-analyst": patch
"@officehum/frontdesk": patch
"@officehum/inventory": patch
"@officehum/it-helpdesk": patch
"@officehum/marketing": patch
"@officehum/office-manager": patch
"@officehum/operations": patch
"@officehum/payroll": patch
"@officehum/people-ops": patch
"@officehum/purchasing": patch
"@officehum/quality": patch
"@officehum/safety": patch
"@officehum/sales": patch
"@officehum/support": patch
---

Role packages carry only the evals a bare harness runs; a host keeps any others. `officehum-role
generate` no longer writes `evals/office.json` or `evals.office.json`, and `officehum-role` drops its
`office-evals` command. The Role Factory exports its render helpers (`clamp`, `json`, `stubText`,
`uniqueId`). `@officehum/cli`'s `EvalOffice` can add a host's suites for a role (`roleSuites`).
