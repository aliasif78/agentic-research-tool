// lib/inngest/client.ts
import { Inngest } from "inngest";

// Deliberately no isDev/mode option set here — mode is controlled entirely
// by the INNGEST_DEV env var (see .env.local), so this file behaves
// identically in dev and production without a code branch. Do not
// hardcode isDev: true here — that would force dev mode even in prod.
export const inngest = new Inngest({
  id: "agentic-research-tool",
});
