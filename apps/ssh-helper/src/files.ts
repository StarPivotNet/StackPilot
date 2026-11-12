import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
export async function rootDirectory(path: string) {
  let current = resolve(path); let leaf = true;
  while (true) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || ((stat.mode & 0o022) && (leaf || !(stat.mode & 0o1000)))) throw new Error("Unsafe root directory");
    const parent = dirname(current); if (parent === current) break; current = parent; leaf = false;
  }
}
export async function rootFile(path: string, maximum = 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o022) || stat.size > maximum) throw new Error("Unsafe root file"); return await file.readFile("utf8"); } finally { await file.close(); }
}
export async function rootExecutable(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.uid !== 0 || stat.nlink < 1 || (stat.mode & 0o022) || !(stat.mode & 0o111)) throw new Error("Unsafe root executable"); } finally { await file.close(); }
}
export async function atomicRootFile(path: string, contents: string, mode: number, validate?: (temporary: string) => Promise<void>) {
  await rootDirectory(dirname(path));
  const temporary = join(dirname(path), `.stackpilot-${randomUUID()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try { await file.chmod(mode); await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await validate?.(temporary); await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}
