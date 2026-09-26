/** Serialize project mutations across sockets; a failed task does not poison the queue. */
export class ProjectTaskQueue {
  private tails = new Map<string, Promise<void>>();
  run(appId: string, task: () => Promise<void>): Promise<void> {
    const result = (this.tails.get(appId) || Promise.resolve()).then(task);
    const tail = result.catch(() => {}).finally(() => {
      if (this.tails.get(appId) === tail) this.tails.delete(appId);
    });
    this.tails.set(appId, tail);
    return result;
  }
}
