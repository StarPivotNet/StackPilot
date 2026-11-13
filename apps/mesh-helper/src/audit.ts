const SENSITIVE = /token|secret|password|private|key|environment|value|authorization|cookie/i;
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(nested)]));
  return typeof value === "string" && value.length > 512 ? `${value.slice(0, 512)}...[TRUNCATED]` : value;
}
export function log(record: Record<string, unknown>) { process.stderr.write(`${JSON.stringify(redact({ time: new Date().toISOString(), ...record }))}\n`); }
