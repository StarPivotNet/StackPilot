/** A coded failure so the task executor can report a stable error code instead of a message. */
export class CacheError extends Error {
  constructor(public readonly code: string, message = "Cache operation failed") {
    super(message);
    this.name = code;
  }
}
