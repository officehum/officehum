// A stand-in for a service's command-line tool, used only by @officehum/sdk's CLI tool tests. It has
// no dependencies and touches nothing but the files its arguments name.
//
// By default it prints, as JSON, exactly what it received: its arguments, its environment, its
// working directory and that directory's files, and whatever arrived on standard input. `--mode`
// changes what it does:
//   text      prints a line of plain text
//   bad-json  prints text that is not JSON
//   fail      writes 5,000+ characters to stderr and exits with code 3
//   big       prints a JSON string of 10,000 characters
//   sleep     writes its pid to the `--started` file, then waits until it is killed
//   sleep-once  sleeps as `sleep` the first time (no `--started` file yet), then prints its argv
// `--log FILE` appends its arguments to FILE as one JSON line, so a test can count its runs.

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const log = option("--log");
if (log !== undefined) appendFileSync(log, `${JSON.stringify(argv)}\n`);

switch (option("--mode") ?? "echo") {
  case "text":
    process.stdout.write("  three labels: bug, docs, release-blocker  \n");
    break;
  case "bad-json":
    process.stdout.write("{ this is not json\n");
    break;
  case "fail":
    process.stderr.write(`tracker: permission denied\n${"x".repeat(5000)}TAIL`);
    process.exit(3);
    break;
  case "big":
    process.stdout.write(JSON.stringify("y".repeat(10_000)));
    break;
  case "sleep": {
    const started = option("--started");
    if (started !== undefined) writeFileSync(started, String(process.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case "sleep-once": {
    const started = option("--started");
    if (started !== undefined && !existsSync(started)) {
      writeFileSync(started, String(process.pid));
      setInterval(() => {}, 1000);
      break;
    }
    process.stdout.write(JSON.stringify({ argv }));
    break;
  }
  default:
    process.stdout.write(
      JSON.stringify({
        argv,
        env: process.env,
        cwd: process.cwd(),
        files: readdirSync("."),
        stdin: readFileSync(0, "utf8"),
      }),
    );
}
