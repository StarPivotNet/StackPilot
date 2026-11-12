import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Node canonicalizes a main module loaded through the installed current link.
 * Compare canonical paths so the service cannot silently exit without running. */
export async function isEntrypoint(url: string) {
  if (!process.argv[1]) return false;
  try { return await realpath(process.argv[1]) === await realpath(fileURLToPath(url)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
