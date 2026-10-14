import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { ResendInbox } from "./resend-inbox.js";

export interface ResendListener {
  readonly address: string;
  close(): Promise<void>;
}

const LIMIT = 256 * 1024;
const TIMEOUT = 10_000;

function headerValues(request: IncomingMessage, name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name)
      result.push(request.rawHeaders[index + 1] ?? "");
  }
  return result;
}

function respond(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    connection: "close",
  });
  response.end(message);
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.length;
    if (length > LIMIT) throw new Error("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

export async function openResendListener(options: {
  inbox: ResendInbox;
  port: number;
}): Promise<ResendListener> {
  if (
    options?.inbox === null ||
    typeof options?.inbox !== "object" ||
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error("Listener configuration is invalid.");
  }
  const sockets = new Set<Socket>();
  let closing = false;
  const server = createServer(async (request, response) => {
    if (closing) return respond(response, 503, "listener closing\n");
    const timer = setTimeout(() => {
      respond(response, 408, "request timeout\n");
      request.destroy();
    }, TIMEOUT);
    try {
      const target = new URL(request.url ?? "", "http://127.0.0.1");
      if (target.pathname !== "/webhooks/resend" || target.search !== "") {
        return respond(response, 404, "not found\n");
      }
      if (request.method !== "POST") return respond(response, 405, "method not allowed\n");
      const contentType = headerValues(request, "content-type");
      if (
        contentType.length !== 1 ||
        contentType[0]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
      ) {
        return respond(response, 415, "unsupported media type\n");
      }
      const ids = headerValues(request, "svix-id");
      const timestamps = headerValues(request, "svix-timestamp");
      const signatures = headerValues(request, "svix-signature");
      if (ids.length !== 1 || timestamps.length !== 1 || signatures.length !== 1) {
        return respond(response, 400, "invalid webhook headers\n");
      }
      const raw = await readBody(request);
      const result = await options.inbox.accept(raw, {
        id: ids[0] ?? "",
        timestamp: timestamps[0] ?? "",
        signature: signatures[0] ?? "",
      });
      respond(response, result.status, result.status === 204 ? "" : "accepted\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "too_large") respond(response, 413, "payload too large\n");
      else if (message.includes("identity conflict")) respond(response, 409, "webhook conflict\n");
      else if (message.includes("signature") || message.includes("timestamp"))
        respond(response, 401, "webhook unauthorized\n");
      else if (message.includes("Receiving event") || message.includes("Webhook"))
        respond(response, 400, "invalid webhook\n");
      else respond(response, 503, "webhook unavailable\n");
    } finally {
      clearTimeout(timer);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    server.close();
    throw new Error("Listener address is unavailable.");
  }
  let closePromise: Promise<void> | undefined;
  return {
    address: `http://127.0.0.1:${bound.port}`,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        closing = true;
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}
