import { readFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const schema = z.object({
  STACKPILOT_CONTROLLER_URL: z.string().url().refine((value) => new URL(value).protocol === "https:", "Controller URL 必须使用 HTTPS"),
  STACKPILOT_AGENT_CA_PATH: z.string().min(1),
  STACKPILOT_AGENT_STATE_DIR: z.string().default(".stackpilot/agent"),
  STACKPILOT_AGENT_NAME: z.string().min(1).max(120).default(hostname()),
  STACKPILOT_AGENT_ENROLLMENT_TOKEN: z.string().min(32).optional(),
  STACKPILOT_AGENT_ENROLLMENT_TOKEN_FILE: z.string().min(1).optional(),
  STACKPILOT_AGENT_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
  STACKPILOT_AGENT_ALLOW_ROOT: z.enum(["0", "1"]).default("0"),
  STACKPILOT_AGENT_ROTATE_CREDENTIAL: z.enum(["0", "1"]).default("0"),
  STACKPILOT_DATABASE_HELPER_SOCKET: z.string().default("/run/stackpilot/database-helper.sock"),
  STACKPILOT_DATABASE_COLLECTION_SECONDS: z.coerce.number().int().min(60).max(3_600).default(60),
}).passthrough();

export type AgentConfig = {
  controllerUrl: string;
  caPath: string;
  stateDir: string;
  nodeName: string;
  enrollmentToken?: string;
  heartbeatSeconds: number;
  allowRoot: boolean;
  rotateCredential: boolean;
  databaseHelperSocket: string;
  databaseCollectionSeconds: number;
  agentVersion: string;
  platform: "linux" | "darwin" | "win32";
};

export function loadAgentConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AgentConfig {
  const value = schema.parse(env);
  const currentPlatform = platform();
  if (value.STACKPILOT_AGENT_ENROLLMENT_TOKEN && value.STACKPILOT_AGENT_ENROLLMENT_TOKEN_FILE) throw new Error("Agent enrollment token and token file cannot both be configured");
  if (!["linux", "darwin", "win32"].includes(currentPlatform)) throw new Error("不支持的 Agent 平台");
  const enrollmentToken = value.STACKPILOT_AGENT_ENROLLMENT_TOKEN
    ?? (value.STACKPILOT_AGENT_ENROLLMENT_TOKEN_FILE ? readFileSync(value.STACKPILOT_AGENT_ENROLLMENT_TOKEN_FILE, "utf8").trim() : undefined);
  return {
    controllerUrl: value.STACKPILOT_CONTROLLER_URL.replace(/\/$/, ""),
    caPath: resolve(value.STACKPILOT_AGENT_CA_PATH),
    stateDir: resolve(value.STACKPILOT_AGENT_STATE_DIR),
    nodeName: value.STACKPILOT_AGENT_NAME,
    ...(enrollmentToken ? { enrollmentToken } : {}),
    heartbeatSeconds: value.STACKPILOT_AGENT_HEARTBEAT_SECONDS,
    allowRoot: value.STACKPILOT_AGENT_ALLOW_ROOT === "1",
    rotateCredential: value.STACKPILOT_AGENT_ROTATE_CREDENTIAL === "1",
    databaseHelperSocket: resolve(value.STACKPILOT_DATABASE_HELPER_SOCKET),
    databaseCollectionSeconds: value.STACKPILOT_DATABASE_COLLECTION_SECONDS,
    agentVersion: "0.3.0-preview.41",
    platform: currentPlatform as AgentConfig["platform"],
  };
}
