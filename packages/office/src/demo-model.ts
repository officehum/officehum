import type { ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";

const PROVIDER = "officehum-demo";
const MODEL = "frontdesk-demo";

function textOf(message: ToolResultMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function latestToolResult(context: TranscriptContext): ToolResultMessage | undefined {
  return [...context.messages].reverse().find((message) => message.role === "toolResult") as
    | ToolResultMessage
    | undefined;
}

const nextDemoResponse: FauxResponseFactory = (context) => {
  const result = latestToolResult(context);
  if (result === undefined) {
    return fauxAssistantMessage(fauxToolCall("check_schedule", { date: "2030-01-15" }), {
      stopReason: "toolUse",
    });
  }
  const text = textOf(result);
  if (result.toolName === "check_schedule") {
    const start = text.match(/2030-01-15T(?:09|10|11):00:00Z/)?.[0];
    if (result.isError || start === undefined) {
      return fauxAssistantMessage(
        result.isError ? `Schedule check failed: ${text}` : "No free UTC slots are available.",
      );
    }
    return fauxAssistantMessage(
      fauxToolCall("book_appointment", { start, customer: "Demo Guest" }),
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage(
    result.isError ? `The appointment was not booked: ${text}` : `Booking result: ${text}`,
  );
};

export function createDemoModels(): {
  models: ReturnType<typeof createModels>;
  model: ModelRef;
} {
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => nextDemoResponse));
  return { models, model: { provider: PROVIDER, modelId: MODEL } };
}
