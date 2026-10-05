# Agents

Each folder here is one Office Hum role agent, published as `@officehum/<role>`.

An agent package is a Pi Durable extension bundle plus an `officehum.json` manifest:
role prompt sections, tools (each marked safe or unsafe to rerun), skills, hooks, and an eval suite.
The same package runs alone (solo mode) or inside the Office with other agents (team mode).

First agents, in milestone M2:

| Folder | Package | Department |
| --- | --- | --- |
| `frontdesk` | `@officehum/frontdesk` | Front office |
| `bookkeeper` | `@officehum/bookkeeper` | Finance |
| `office-manager` | `@officehum/office-manager` | Operations |
