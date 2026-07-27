// scripts/measure-done-compliance.ts
// Fires N real requests against the LOCAL DEV SERVER (must already be running
// with the synthetic webSearch outage in place — see web-search.ts). Measures
// done-compliance under total search failure, replacing the old N=10 manual
// log-reading with a real, scripted, repeatable measurement.
//
// Requires: npm run dev already running in another terminal.

const N = 20;
const ENDPOINT = "http://localhost:3000/api/research";
const TOPIC = "current US inflation rate";

interface RunResult {
  index: number;
  sessionId: string | null;
  httpStatus: number;
  terminatedByDone: boolean | null;
  hadWarning: boolean;
  warningText: string | null;
  elapsedMs: number;
  rawError: string | null;
}

async function runOnce(index: number): Promise<RunResult> {
  const start = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: TOPIC }),
    });
    const elapsedMs = Date.now() - start;
    const body = await res.json();

    return {
      index,
      sessionId: body.sessionId ?? null,
      httpStatus: res.status,
      terminatedByDone: typeof body.terminatedByDone === "boolean" ? body.terminatedByDone : null,
      hadWarning: Boolean(body.warning),
      warningText: body.warning ?? null,
      elapsedMs,
      rawError: res.status !== 200 ? JSON.stringify(body) : null,
    };
  } catch (err) {
    return {
      index,
      sessionId: null,
      httpStatus: 0,
      terminatedByDone: null,
      hadWarning: false,
      warningText: null,
      elapsedMs: Date.now() - start,
      rawError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`Running ${N} sequential requests against ${ENDPOINT}, topic: "${TOPIC}"`);
  console.log("Sequential, not parallel — avoids overlapping traces and rate-limit noise.\n");

  const results: RunResult[] = [];

  for (let i = 1; i <= N; i++) {
    console.log(`--- Run ${i}/${N} ---`);
    const result = await runOnce(i);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }

  const compliant = results.filter((r) => r.terminatedByDone === true);
  const nonCompliantButOk = results.filter((r) => r.terminatedByDone === false && r.httpStatus === 200);
  const hardFailures = results.filter((r) => r.httpStatus !== 200);

  console.log("\n=== SUMMARY ===");
  console.log(`Total runs: ${N}`);
  console.log(`Terminated via done (compliant): ${compliant.length}/${N} = ${((compliant.length / N) * 100).toFixed(1)}%`);
  console.log(`Ended without done, no hard error (compliance failure): ${nonCompliantButOk.length}/${N}`);
  console.log(`Hard failures (non-200 status, e.g. both models down): ${hardFailures.length}/${N}`);

  if (nonCompliantButOk.length > 0) {
    console.log("\nNon-compliant session IDs (inspect these in Langfuse):");
    nonCompliantButOk.forEach((r) => console.log(`  - ${r.sessionId} (run ${r.index}): ${r.warningText}`));
  }

  if (hardFailures.length > 0) {
    console.log("\nHard-failure session IDs (unexpected — investigate):");
    hardFailures.forEach((r) => console.log(`  - ${r.sessionId ?? "unknown"} (run ${r.index}): ${r.rawError}`));
  }
}

main().catch((err) => {
  console.error("Measurement script crashed:", err);
  process.exit(1);
});
