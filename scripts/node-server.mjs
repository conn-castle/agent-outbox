import { createServer } from "node:http";

const mode = process.argv[2];
const port = Number(process.env.PORT);
const hostname = mode === "dev" ? "0.0.0.0" : "127.0.0.1";
if (mode !== "dev" && mode !== "start") {
  throw new Error("Node server mode must be dev or start.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

Object.assign(process.env, {
  NODE_ENV: mode === "dev" ? "development" : "production"
});
const { default: next } = await import("next");
const { apiErrorResponse, apiRequestContext } =
  await import("../src/server/api-errors.ts");
const { createCorrelationId } = await import("../src/server/correlation.ts");
const { reportFetchRuntimeFailure } = await import("../src/server/sentry.ts");
const { handleNodeIngress } = await import("./node-ingress.mjs");

const server = createServer(async (request, response) => {
  try {
    await handleNodeIngress(request, response, handle);
  } catch (error) {
    const errorId = createCorrelationId("node_ingress");
    await reportFetchRuntimeFailure(error, {
      errorId,
      surface: "app",
      operation: "node_ingress",
      status_code: 503,
      message: "Node request failed unexpectedly."
    });
    if (response.headersSent || response.destroyed) {
      response.destroy();
      return;
    }
    const unavailable = apiErrorResponse(
      apiRequestContext(new Request("http://node-ingress"), "node_ingress"),
      {
        status: 503,
        code: "temporary_unavailable",
        message: "Service is temporarily unavailable.",
        errorId,
        reported: true
      }
    );
    response.statusCode = unavailable.status;
    unavailable.headers.forEach((value, name) =>
      response.setHeader(name, value)
    );
    response.setHeader("Connection", "close");
    response.end(await unavailable.text());
  }
});
const app = next({ dev: mode === "dev", hostname, port, httpServer: server });
await app.prepare();
const handle = app.getRequestHandler();
server.once("error", (error) => {
  throw error;
});
server.listen(port, hostname, () => {
  console.log(`Agent Outbox Node server ready at http://${hostname}:${port}`);
});

for (const signal of /** @type {NodeJS.Signals[]} */ ([
  "SIGINT",
  "SIGTERM",
  "SIGHUP"
])) {
  process.once(signal, async () => {
    server.close();
    server.closeAllConnections();
    await app.close();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}
