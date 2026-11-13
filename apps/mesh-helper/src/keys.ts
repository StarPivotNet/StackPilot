import type { MeshHelperConfig } from "./config.js";
import { realFileOperations, type FileOperations } from "./files.js";
import { runFixedCommand, WG_EXECUTABLE, type FixedCommandRunner } from "./runner.js";
import { HelperError } from "./types.js";
import { PUBLIC_KEY } from "./validation.js";

const KEY_TIMEOUT_MS = 5_000;

export type KeyDependencies = { run?: FixedCommandRunner; files?: FileOperations };

export const meshKeyPath = (config: MeshHelperConfig) => `${config.stateRoot}/${config.interfaceName}.key`;

export async function derivePublicKey(privateKey: string, run: FixedCommandRunner): Promise<string> {
  const { stdout } = await run(WG_EXECUTABLE, ["pubkey"], KEY_TIMEOUT_MS, `${privateKey}\n`);
  const publicKey = stdout.trim();
  if (!PUBLIC_KEY.test(publicKey)) throw new HelperError("KEY_DERIVATION_FAILED", "WireGuard public key derivation returned an unexpected value");
  return publicKey;
}

/** The private key is generated and stored only on this host; callers receive the public key. */
export async function ensureMeshKey(config: MeshHelperConfig, dependencies: KeyDependencies = {}) {
  const files = dependencies.files ?? realFileOperations;
  const run = dependencies.run ?? runFixedCommand;
  const path = meshKeyPath(config);
  const stored = (await files.read(path))?.trim() ?? "";
  if (PUBLIC_KEY.test(stored)) return { privateKey: stored, publicKey: await derivePublicKey(stored, run) };
  const generated = (await run(WG_EXECUTABLE, ["genkey"], KEY_TIMEOUT_MS)).stdout.trim();
  if (!PUBLIC_KEY.test(generated)) throw new HelperError("KEY_GENERATION_FAILED", "WireGuard key generation returned an unexpected value");
  await files.ensureDirectory(config.stateRoot);
  await files.writePrivate(path, `${generated}\n`);
  return { privateKey: generated, publicKey: await derivePublicKey(generated, run) };
}
