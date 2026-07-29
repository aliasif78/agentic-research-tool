// scripts/send-human-input.ts
import "dotenv/config";
import { inngest } from "@/lib/inngest/client";

async function main() {
  const [, , runId, decision, extraContext] = process.argv;

  if (!runId || (decision !== "continue" && decision !== "add-context")) {
    console.error("Usage: npx tsx scripts/send-human-input.ts <runId> <continue|add-context> [extraContext]");
    process.exit(1);
  }

  await inngest.send({
    name: "research/human-input",
    data: { runId, decision, ...(extraContext ? { extraContext } : {}) },
  });

  console.log("Sent research/human-input event:", { runId, decision, extraContext });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
