import { describe, expect, it } from "vitest";
import { parseE164 } from "./adapter.js";
import { FAKE_NUMBER, FakeNumberProvisioner, type NumberProvisioner } from "./provision.js";

describe("FakeNumberProvisioner", () => {
  it("is a NumberProvisioner, and hands out a reserved-range number", async () => {
    const provisioner: NumberProvisioner = new FakeNumberProvisioner();
    const { number } = await provisioner.provision("acme-hvac");
    expect(number).toBe(FAKE_NUMBER);
    // From 555-0100–555-0199, the range reserved for fiction: valid E.164, nobody's phone.
    expect(number.startsWith("+1500555")).toBe(true);
    expect(parseE164(number)).toBe(number);
  });

  it("records every call, in order, with the number it answered", async () => {
    const provisioner = new FakeNumberProvisioner();
    await provisioner.provision("acme-hvac");
    await provisioner.provision("second-office");
    expect(provisioner.calls).toEqual([
      { companyId: "acme-hvac", number: FAKE_NUMBER },
      { companyId: "second-office", number: FAKE_NUMBER },
    ]);
  });

  it("accepts another reserved number, and refuses one that is not E.164", () => {
    expect(new FakeNumberProvisioner("+15005550100")).toBeInstanceOf(FakeNumberProvisioner);
    expect(() => new FakeNumberProvisioner("555-0100")).toThrow(/E\.164/);
  });

  it("refuses to provision for nobody", () => {
    const provisioner = new FakeNumberProvisioner();
    expect(() => provisioner.provision(" ")).toThrow(/company/);
    expect(provisioner.calls).toEqual([]);
  });
});
