// instrumentation.ts
export async function register() {
  // Only run in the Node.js runtime, not edge — matches route.ts's own
  // `export const runtime = "nodejs"`. Importing OTel/Node SDK packages
  // into an edge bundle would break the build.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("[instrumentation] Langfuse telemetry registered");

    const { registerTelemetry } = await import("ai");
    const { LangfuseSpanProcessor } = await import("@langfuse/otel");
    const { LangfuseVercelAiSdkIntegration } = await import("@langfuse/vercel-ai-sdk");
    const { NodeSDK } = await import("@opentelemetry/sdk-node");

    const langfuseSpanProcessor = new LangfuseSpanProcessor();
    const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
    sdk.start();

    registerTelemetry(new LangfuseVercelAiSdkIntegration());

    // Exposed globally so route.ts can force-flush before a serverless
    // function's sandbox is frozen/killed after the response is sent —
    // Langfuse buffers spans async, and a non-streaming JSON response has
    // no guaranteed post-response window unless we flush explicitly.
    (globalThis as { __langfuseSpanProcessor?: InstanceType<typeof LangfuseSpanProcessor> }).__langfuseSpanProcessor = langfuseSpanProcessor;
  }
}
