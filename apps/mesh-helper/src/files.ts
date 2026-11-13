import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type FileOperations = {
  read(path: string): Promise<string | null>;
  writePrivate(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
};

/** Every mesh file is private to root; writes go through a temporary file and an atomic rename. */
export const realFileOperations: FileOperations = {
  async read(path) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  },
  async writePrivate(path, content) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  },
  async remove(path) { await unlink(path).catch(() => undefined); },
  async ensureDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); },
};
