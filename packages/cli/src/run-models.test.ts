import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { PAPER_MODEL_REF } from "@officehum/provider-paper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_PROVIDERS, liveModels, liveProvider, runModels } from "./run.js";

// Obviously fake values: nothing here reaches a provider, and no request is made.
const FAKE_KEY = "test-key-not-real";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runModels", () => {
  it("runs a pi-ai built-in provider when its key is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    const [first] = builtinProviders()
      .find((provider) => provider.id === "anthropic")
      ?.getModels() ?? [undefined];
    const modelId = first?.id ?? "";
    const { models, model } = await runModels({ provider: "anthropic", modelId }, {});
    expect(model).toEqual({ provider: "anthropic", modelId });
    expect(models.getModel("anthropic", modelId)?.id).toBe(modelId);
  });

  it("runs an OpenRouter model with OPENROUTER_API_KEY", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", FAKE_KEY);
    const [first] = builtinProviders()
      .find((provider) => provider.id === "openrouter")
      ?.getModels() ?? [undefined];
    const modelId = first?.id ?? "";
    const { models } = await runModels({ provider: "openrouter", modelId }, {});
    expect(models.getModel("openrouter", modelId)).toBeDefined();
  });

  it("names the variable to set when a built-in provider has no key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const modelId =
      builtinProviders()
        .find((provider) => provider.id === "openrouter")
        ?.getModels()[0]?.id ?? "";
    await expect(runModels({ provider: "openrouter", modelId }, {})).rejects.toThrow(
      "Set OPENROUTER_API_KEY in your shell before running against openrouter.",
    );
  });

  it("names every variable pi-ai looked for when a provider reads several", async () => {
    for (const name of [
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    ]) {
      vi.stubEnv(name, "");
    }
    const modelId =
      builtinProviders()
        .find((provider) => provider.id === "amazon-bedrock")
        ?.getModels()[0]?.id ?? "";
    const refused = runModels({ provider: "amazon-bedrock", modelId }, {});
    await expect(refused).rejects.toThrow(
      "pi-ai found no amazon-bedrock credential in your environment.",
    );
    await expect(refused).rejects.toThrow(/AWS_PROFILE/);
  });

  it("refuses a provider that signs in with OAuth only", async () => {
    const modelId =
      builtinProviders()
        .find((provider) => provider.id === "openai-codex")
        ?.getModels()[0]?.id ?? "";
    await expect(runModels({ provider: "openai-codex", modelId }, {})).rejects.toThrow(
      "The openai-codex provider signs in with OAuth only",
    );
  });

  it("refuses an unknown provider, listing every provider it can run", async () => {
    const refused = runModels({ provider: "wat", modelId: "thing" }, {}, "eval");
    await expect(refused).rejects.toThrow('The eval command has no model provider "wat".');
    const message = await refused.catch((error: Error) => error.message);
    expect(message).toContain("paper, local, ");
    for (const provider of builtinProviders()) expect(message).toContain(provider.id);
  });

  it("refuses an unknown model id of a known provider, listing its models", async () => {
    const ids =
      builtinProviders()
        .find((provider) => provider.id === "deepseek")
        ?.getModels()
        .map((model) => model.id) ?? [];
    await expect(runModels({ provider: "deepseek", modelId: "no-such-model" }, {})).rejects.toThrow(
      `Unknown deepseek model: no-such-model. pi-ai's deepseek models (${ids.length}): ${ids.join(", ")}.`,
    );
  });

  it("lists only the first 20 model ids of a long catalogue, with the full count", async () => {
    const ids =
      builtinProviders()
        .find((provider) => provider.id === "openrouter")
        ?.getModels()
        .map((model) => model.id) ?? [];
    expect(ids.length).toBeGreaterThan(20);
    const message = await runModels({ provider: "openrouter", modelId: "no-such-model" }, {}).catch(
      (error: Error) => error.message,
    );
    expect(message).toBe(
      `Unknown openrouter model: no-such-model. pi-ai's openrouter models (${ids.length}): ${ids.slice(0, 20).join(", ")}, … and ${ids.length - 20} more.`,
    );
  });

  it("keeps paper on PAPERINSTRUMENTS_API_KEY", async () => {
    vi.stubEnv("PAPERINSTRUMENTS_API_KEY", "");
    await expect(runModels(PAPER_MODEL_REF, {})).rejects.toThrow(
      "Set PAPERINSTRUMENTS_API_KEY in your shell before running against paper.",
    );
    vi.stubEnv("PAPERINSTRUMENTS_API_KEY", FAKE_KEY);
    const { models } = await runModels(PAPER_MODEL_REF, {});
    expect(models.getModel("paper", PAPER_MODEL_REF.modelId)).toBeDefined();
  });

  it("keeps openai on OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "  ");
    await expect(runModels({ provider: "openai", modelId: "gpt-6-sol" }, {})).rejects.toThrow(
      "Set OPENAI_API_KEY in your shell before running against openai.",
    );
    vi.stubEnv("OPENAI_API_KEY", FAKE_KEY);
    const { models } = await runModels({ provider: "openai", modelId: "gpt-6-sol" }, {});
    expect(models.getModel("openai", "gpt-6-sol")).toBeDefined();
  });

  it("keeps local on OFFICEHUM_LOCAL_BASE_URL", async () => {
    vi.stubEnv("OFFICEHUM_LOCAL_BASE_URL", "");
    await expect(runModels({ provider: "local", modelId: "any-model" }, {})).rejects.toThrow(
      "Set OFFICEHUM_LOCAL_BASE_URL",
    );
    vi.stubEnv("OFFICEHUM_LOCAL_BASE_URL", "http://localhost:8080/v1");
    const { models } = await runModels({ provider: "local", modelId: "any-model" }, {});
    expect(models.getModel("local", "any-model")).toBeDefined();
  });

  it("keeps the default model at paper/ultramarine-1-flash", () => {
    expect(PAPER_MODEL_REF).toEqual({ provider: "paper", modelId: "ultramarine-1-flash" });
  });
});

describe("liveModels, the providers a multi-role host runs", () => {
  it("stay paper and openai", () => {
    expect(Object.keys(LIVE_PROVIDERS)).toEqual(["paper", "openai"]);
    expect(liveProvider("anthropic")).toBeUndefined();
    expect(liveProvider("local")).toBeUndefined();
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    expect(() => liveModels([{ provider: "anthropic", modelId: "claude-x" }], "runtime")).toThrow(
      "runs paper or openai models",
    );
  });
});
