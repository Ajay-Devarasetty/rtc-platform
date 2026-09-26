import test from "node:test";
import assert from "node:assert/strict";
import { ProjectTaskQueue } from "./task-queue.js";

test("project tasks stay ordered after failures while other projects continue", async () => {
  const queue = new ProjectTaskQueue();
  const order: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run("a", async () => { await gate; order.push(1); throw new Error("failed"); });
  const rejection = assert.rejects(first, /failed/);
  const next = queue.run("a", async () => { order.push(2); });
  await queue.run("b", async () => { order.push(0); });
  assert.deepEqual(order, [0]);
  release();
  await rejection;
  await next;
  assert.deepEqual(order, [0, 1, 2]);
});
