import { describe, expect, it } from "vitest";
import { parseHealthUrl } from "./health-url";

describe("parseHealthUrl", () => {
  it.each([
    "https://app1.breakthruventures.ai/api/health",
    "https://breakthruventures.ai/api/health",
    "https://abc123.execute-api.us-east-2.amazonaws.com/api/health",
    "https://x.azurecontainerapps.io/api/health",
    "https://svc-abc.run.app/api/health",
    "https://1-2-3-4.sslip.io/api/health",
  ])("accepts %s", (u) => expect(parseHealthUrl(u)).not.toBeNull());

  it.each([
    "http://app1.breakthruventures.ai/api/health",
    "https://evil.com/",
    "https://evil.com/.breakthruventures.ai",
    "https://breakthruventures.ai.evil.com/",
    "https://notbreakthruventures.ai/",
    "https://user:pw@app1.breakthruventures.ai/",
    "https://app1.breakthruventures.ai:8443/",
    "https://app1.breakthruventures.ai./",
    "https://169.254.169.254/latest/meta-data",
    "https://execute-api.us-west-2.amazonaws.com/",
    "ftp://app1.breakthruventures.ai/",
    "not a url",
    "",
  ])("rejects %s", (u) => expect(parseHealthUrl(u)).toBeNull());
});
