// lib/inngest/functions/hello-world.ts
// Throwaway wiring-verification function for Phase 0. Delete this file
// once Phase 3's real research-agent function is registered and tested —
// it has no purpose beyond confirming the /api/inngest route, the dev
// server connection, and step.run() checkpointing actually work end to end.
import { inngest } from "@/lib/inngest/client";

export const helloWorld = inngest.createFunction(
  {
    id: "hello-world",
    triggers: { event: "test/hello" },
  },
  async ({ event, step }) => {
    const greeting = await step.run("build-greeting", async () => {
      return { message: `Hello, ${event.data?.name ?? "world"}!` };
    });

    return greeting;
  },
);
