import { describe, expect, it, vi } from "vitest";
import { checkHealth } from "./sync";

const URL_OK = "https://app2.breakthruventures.ai/api/health";
const lookup = async () => [{ address: "93.184.216.34" }];
const sleep = async () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const timeoutError = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
const deps = (f: typeof fetch) => ({ fetch: f, lookup, sleep });

describe("checkHealth retries", () => {
  it("records ok when the first attempt times out and the retry succeeds", async () => {
    const f = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(json({ status: "ok", version: "abc" }));
    const r = await checkHealth(URL_OK, new AbortController().signal, deps(f));
    expect(f).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ kind: "checked", health: "ok", version: "abc" });
  });

  it("reports the latency of the successful attempt only", async () => {
    let t = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => t);
    const f = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      t += 6000;
      throw timeoutError();
    });
    f.mockImplementationOnce(async () => {
      t += 120;
      return json({ status: "ok" });
    });
    const r = await checkHealth(URL_OK, new AbortController().signal, deps(f));
    now.mockRestore();
    expect(r).toMatchObject({ health: "ok", ms: 120 });
  });

  it("records down only after every attempt fails", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(timeoutError());
    const r = await checkHealth(URL_OK, new AbortController().signal, deps(f));
    expect(f).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ kind: "checked", health: "down" });
  });

  it("still records down for a real 5xx", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async () => json({}, 500));
    const r = await checkHealth(URL_OK, new AbortController().signal, deps(f));
    expect(r).toMatchObject({ kind: "checked", health: "down" });
  });

  it("does not retry a degraded answer", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(json({ status: "degraded" }, 503));
    const r = await checkHealth(URL_OK, new AbortController().signal, deps(f));
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ health: "degraded" });
  });

  it("stops retrying when the sync deadline passes", async () => {
    const ctl = new AbortController();
    const f = vi.fn<typeof fetch>().mockImplementation(async () => {
      ctl.abort();
      throw timeoutError();
    });
    const r = await checkHealth(URL_OK, ctl.signal, deps(f));
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ kind: "skipped", reason: "sync_deadline" });
  });
});
