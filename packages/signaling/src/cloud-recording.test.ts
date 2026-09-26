import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudRecording, stopCloudRecording, getActiveCloudRecording, resetCloudRecordings } from "./cloud-recording.js";

test("recording failures allow retry, keep failed stops active, and isolate projects", async (t) => {
  const previous = process.env.SFU_URL; process.env.SFU_URL = "http://sfu.test";
  const dir = await mkdtemp(join(tmpdir(), "rtc-recording-test-"));
  t.after(async () => { resetCloudRecordings(); await rmdir(dir); if (previous === undefined) delete process.env.SFU_URL; else process.env.SFU_URL = previous; });
  const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await assert.rejects(startCloudRecording("a", "r", "host", dir), /offline/);
  assert.equal(getActiveCloudRecording("r", "a"), null);
  request.mock.mockImplementation(async () => new Response("{}", { status: 200 }));
  await startCloudRecording("a", "r", "host", dir);
  await startCloudRecording("b", "r", "host", dir);
  request.mock.mockImplementation(async () => new Response("{}", { status: 503 }));
  await assert.rejects(stopCloudRecording("r", dir, "secret", "a", "host"), /503/);
  assert.equal(getActiveCloudRecording("r", "a")?.status, "recording");
  request.mock.mockImplementation(async () => new Response("{}", { status: 200 }));
  await stopCloudRecording("r", dir, "secret", "a", "host");
  assert.equal(getActiveCloudRecording("r", "a"), null);
  assert.equal(getActiveCloudRecording("r", "b")?.status, "recording");
});
