// // scripts/measure-done-compliance-v2.ts
// // Fires N real requests against the LIVE server, driving each run through
// // the full lifecycle: trigger -> poll -> auto-resume with "continue" at
// // the checkpoint -> poll to terminal. Requires `npm run dev` and
// // `inngest dev` both running.

// const N = 20;
// const BASE = "http://localhost:3000";
// const TOPIC = "current US inflation rate";
// const POLL_INTERVAL_MS = 2000;
// const RUN_TIMEOUT_MS = 3 * 60 * 1000; // safety ceiling per run, not the 10-minute checkpoint timeout

// interface RunOutcome {
//   index: number;
//   runId: string | null;
//   status: string | null;
//   terminatedByDone: boolean | null;
//   warning: string | null;
//   timedOutInScript: boolean;
// }

// async function sleep(ms: number) {
//   return new Promise((res) => setTimeout(res, ms));
// }

// async function runOnce(index: number): Promise<RunOutcome> {
//   const triggerRes = await fetch(`${BASE}/api/research`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ topic: TOPIC }),
//   });
//   const { runId } = await triggerRes.json();

//   const start = Date.now();
//   let resumed = false;

//   while (Date.now() - start < RUN_TIMEOUT_MS) {
//     const res = await fetch(`${BASE}/api/research/${runId}`);
//     const data = await res.json();

//     if (data.status === "awaiting_human_input" && !resumed) {
//       resumed = true;
//       await fetch(`${BASE}/api/research/${runId}/resume`, {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ decision: "continue" }),
//       });
//     }

//     if (["done", "failed", "abandoned"].includes(data.status)) {
//       return { index, runId, status: data.status, terminatedByDone: data.terminatedByDone, warning: data.warning, timedOutInScript: false };
//     }

//     await sleep(POLL_INTERVAL_MS);
//   }

//   return { index, runId, status: "unknown", terminatedByDone: null, warning: null, timedOutInScript: true };
// }

// async function main() {
//   console.log(`Running ${N} sequential full-lifecycle requests, topic: "${TOPIC}"`);
//   const results: RunOutcome[] = [];

//   for (let i = 1; i <= N; i++) {
//     console.log(`--- Run ${i}/${N} ---`);
//     const outcome = await runOnce(i);
//     results.push(outcome);
//     console.log(JSON.stringify(outcome, null, 2));
//   }

//   const compliant = results.filter((r) => r.terminatedByDone === true);
//   const softDone = results.filter((r) => r.status === "done" && r.terminatedByDone === false);
//   const failed = results.filter((r) => r.status === "failed");
//   const stuck = results.filter((r) => r.timedOutInScript);

//   console.log("\n=== SUMMARY ===");
//   console.log(`Terminated via done: ${compliant.length}/${N} = ${((compliant.length / N) * 100).toFixed(1)}%`);
//   console.log(`Done without a done call (compliance gap, had text): ${softDone.length}/${N}`);
//   console.log(`Failed (ceiling hit or no text at all): ${failed.length}/${N}`);
//   console.log(`Script-level timeout (stuck beyond ${RUN_TIMEOUT_MS}ms): ${stuck.length}/${N}`);
// }

// main().catch((err) => {
//   console.error(err);
//   process.exit(1);
// });
