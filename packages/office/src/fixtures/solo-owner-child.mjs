import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import frontdesk from "@officehum/frontdesk";
import { createDemoModels, openLocalCalendar, openSolo } from "@officehum/office";

const directory = process.env.OFFICEHUM_TEST_DIRECTORY;
const side = process.env.OFFICEHUM_TEST_SIDE ?? "child";
if (directory === undefined) throw new Error("OFFICEHUM_TEST_DIRECTORY is required");

const pause = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (name) => {
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(directory, name))) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${name}`);
    Atomics.wait(pause, 0, 0, 5);
  }
};

if (process.env.OFFICEHUM_TEST_FORCE_STALE_RACE === "1") {
  const originalKill = process.kill;
  process.kill = (pid, ...rest) => {
    if (pid !== 99_999_999) return originalKill(pid, ...rest);
    writeFileSync(join(directory, `${side}-stale-read`), "yes");
    if (side === "a") waitFor("b-stale-read");
    else waitFor("a-ready");
    throw Object.assign(new Error("dead"), { code: "ESRCH" });
  };
}

const send = (message) =>
  new Promise((resolve, reject) => {
    if (process.send === undefined) return resolve();
    process.send(message, (error) => (error === null ? resolve() : reject(error)));
  });
let calendar;
try {
  calendar = openLocalCalendar(join(directory, `calendar-${side}.sqlite`));
  const solo = await openSolo({
    directory,
    role: frontdesk({ calendar }),
    ...createDemoModels(),
  });
  writeFileSync(join(directory, `${side}-ready`), "yes");
  const closeRequested = new Promise((resolve) => process.once("message", resolve));
  let timeout;
  const hold = new Promise((resolve) => {
    timeout = setTimeout(resolve, 5_000);
  });
  await send({
    status: "opened",
    pid: process.pid,
    marker: JSON.parse(readFileSync(join(directory, "owner.lock"), "utf8")),
  });
  await Promise.race([closeRequested, hold]);
  clearTimeout(timeout);
  await solo.close();
} catch (error) {
  await send({ status: "error", message: error instanceof Error ? error.message : String(error) });
} finally {
  calendar?.close();
  process.disconnect?.();
}
