import { describe, expect, it } from "vitest";
import { optOutCommand, START_KEYWORDS, STOP_KEYWORDS } from "./optout.js";

describe("opt-out keywords", () => {
  it("carries Twilio's list, both directions", () => {
    expect(STOP_KEYWORDS).toEqual(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
    expect(START_KEYWORDS).toEqual(["START", "UNSTOP", "YES"]);
  });

  it("recognises every stop keyword, whatever its case and whitespace", () => {
    for (const keyword of STOP_KEYWORDS) {
      expect(optOutCommand(keyword)).toBe("stop");
      expect(optOutCommand(keyword.toLowerCase())).toBe("stop");
      expect(optOutCommand(`  ${keyword.toLowerCase()}\n`)).toBe("stop");
    }
  });

  it("recognises every start keyword the same way", () => {
    for (const keyword of START_KEYWORDS) {
      expect(optOutCommand(keyword)).toBe("start");
      expect(optOutCommand(`\t${keyword.toLowerCase()} `)).toBe("start");
    }
  });

  it("treats an ordinary message as a message, even when it says stop", () => {
    for (const body of [
      "please stop texting me",
      "STOP.",
      "stop!",
      "can you stop by tomorrow",
      "i want to start a job",
      "",
      "   ",
    ]) {
      expect(optOutCommand(body)).toBeUndefined();
    }
  });

  it("does not treat other words as instructions", () => {
    for (const body of ["HELP", "STOPALLX", "unsubscribe me", "Y", "NO"]) {
      expect(optOutCommand(body)).toBeUndefined();
    }
  });
});
