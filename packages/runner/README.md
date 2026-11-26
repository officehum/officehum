# @officehum/runner

Runs one Office Hum role package on a Pi Durable harness. It holds the harness adapter, the only
code in Office Hum that opens and drives a Pi Durable `Harness`, and what running a single role
needs on top of it:

- `loadRole(dir, options)`: validates a role package (`validatePackage`), checks that its Pi Durable
  range includes the release this package is built against (`PI_DURABLE_VERSION`) and that the
  programs its engine needs are installed, imports its compiled entry and builds it.
- `openRoleRun(options)`: one role over one SQLite file, with `submit`, `resume` after a crash,
  `reload` and the manifest's operator commands. `officehum run` is this behind a command line.
- `openLocalCalendar(file)`: the SQLite calendar a Front Desk books into when no calendar app is
  connected.
- `piDurableRunner(options)`: the SDK's `AgentRunner` for `runEvals`. It runs each scenario on a
  fresh bare harness with the role's declared tools stubbed, and records which calls ran and which
  a hook refused. A host can add to a trial through `TrialHost`; the office's eval mode does.
- `modelJudge(model)`: the judge an eval run grades judged replies with, and the usage and output-cap
  helpers an eval run reports cost with.
- `redactKeyErrors(provider)`: keeps a live provider's API key out of the errors it throws.
- `@officehum/runner/testing`: the scripted model (`scriptedProvider`), so a test or a keyless run
  needs no provider and no key.

It depends only on `@officehum/sdk` and the exact Pi Durable and pi-ai releases it is tested
against. The office (workboard, relay, runtime) builds on it; a role package never depends on it at
runtime, though its tests may.

## Install

Not published to npm yet. In a clone of this repository, `npm ci && npm run build` builds it and
workspaces import it by name.

## Use it

```ts
import { loadRole, openRoleRun } from "@officehum/runner";
import { scriptedProvider } from "@officehum/runner/testing";

// The scripted model replays a fixed script instead of calling a provider.
const scripted = scriptedProvider([{ text: "Here is your quote." }]);
const role = await loadRole("agents/sales", { demo: true });
const run = await openRoleRun({
  role,
  database: "run.sqlite",
  models: scripted.models,
  model: scripted.model,
});
const result = await run.submit("Quote a deep clean for Riverside Dental.", "request-1");
console.log(result.text);
await run.close();
```

## Docs

- [Build a role](../../docs/build-a-role.md): writing, running and evaluating a role package.
- [Reference](../../docs/reference.md#run-one-role-package): `officehum run` and `officehum eval`.
- [agent-package.md](../../docs/design/agent-package.md): the role package contract.
