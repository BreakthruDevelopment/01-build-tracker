/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  // "daily-health-summary" is added with the AI feature.
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
