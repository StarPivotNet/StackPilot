import type { RemoteTaskStatusUpdate } from "@stackpilot/contracts";
import type { TaskExecutor } from "./executor.js";

/** One rejected receipt must not block delivery of other results or the next task poll. */
export async function flushTaskUpdates(executor: TaskExecutor, deliver: (update: RemoteTaskStatusUpdate) => Promise<unknown>, onFailure: (taskId: string, error: unknown) => void) {
  for (const pending of executor.pendingUpdates()) {
    try {
      await deliver(pending);
      await executor.markReported(pending.taskId, pending);
    } catch (error) { onFailure(pending.taskId, error); }
  }
}
