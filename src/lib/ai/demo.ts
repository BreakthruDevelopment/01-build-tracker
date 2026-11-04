/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  // Entries for apps that are not in a batch are dropped, and apps missing here get a rule-only
  // summary, so this one fixture works for any batch.
  "daily-health-summary": {
    apps: [
      {
        n: 1,
        health: "green",
        summary: "Live on AWS, health ok on sha-1a2b3c4. CI green; last push 3 hours ago.",
        flags: [],
      },
      {
        n: 2,
        health: "amber",
        summary: "Building; no push for 26 hours and one PR waiting on review.",
        flags: [{ kind: "stalled", detail: "No push for 26 h; PR #3 waiting on review" }],
      },
    ],
  },
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
