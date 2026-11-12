import {
  SystemdJournalPayloadSchema, SystemdServicesPayloadSchema, SystemdUnitSchema, SystemdUnitsPayloadSchema,
  type NodeScope, type SystemdServicesPayload, type SystemdUnitAction, type SystemdUnitsPayload,
} from "@stackpilot/contracts";
import type { AgentControlRepository } from "../../repositories/agentControlRepository.js";
import { requestSystemdHelper, SystemdHelperError, type SystemdHelperRequester } from "../../platform/systemdClient.js";
import { ServiceError } from "../serviceError.js";

function helperFailure(error: unknown): never {
  const code = error instanceof SystemdHelperError ? error.code : "SYSTEMD_BACKEND_FAILED";
  const unavailable = code.includes("UNAVAILABLE") || code.includes("TIMEOUT");
  throw new ServiceError(unavailable ? 503 : 502, "INTERNAL_ERROR", unavailable ? "systemd 运维后端暂不可用" : "systemd 操作失败，请查看服务日志");
}

export class SystemdService {
  private readonly actions = new Map<string, { unit: string; action: SystemdUnitAction; result: Promise<import("@stackpilot/contracts").SystemdUnit> }>();

  constructor(
    private readonly repository: AgentControlRepository,
    private readonly staleAfterMs = 45_000,
    private readonly helper: SystemdHelperRequester = requestSystemdHelper,
  ) {}

  async list(): Promise<SystemdUnitsPayload>;
  async list(nodeScope: NodeScope): Promise<SystemdServicesPayload>;
  async list(nodeScope?: NodeScope): Promise<SystemdUnitsPayload | SystemdServicesPayload> {
    if (nodeScope === undefined) {
      try {
        const response = await this.helper({ operation: "systemd-list" });
        return SystemdUnitsPayloadSchema.parse(response.data);
      } catch (error) { return helperFailure(error); }
    }

    const state = await this.repository.read({ sections: ["nodes"] }); const now = Date.now(); const warnings: string[] = []; const timestamps: string[] = [];
    const nodes = state.nodes.filter((node) => !node.revokedAt && (nodeScope === "all" || nodeScope.includes(node.nodeId)));
    const services = nodes.flatMap((node) => {
      const snapshot = node.systemdSnapshot;
      if (!snapshot) { warnings.push(`${node.nodeName}: awaiting systemd collection`); return []; }
      timestamps.push(snapshot.collectedAt); warnings.push(...snapshot.warnings.map((warning) => `${node.nodeName}: ${warning}`));
      const freshness = node.status === "online" && now - Date.parse(snapshot.collectedAt) <= this.staleAfterMs ? "current" as const : "stale" as const;
      if (freshness === "stale") warnings.push(`${node.nodeName}: systemd snapshot is stale`);
      return snapshot.services.map((service) => ({
        ...service, id: `${node.nodeId}:${service.unit}`, nodeId: node.nodeId, host: node.nodeName,
        platform: node.platform, sourceCollectedAt: snapshot.collectedAt, freshness,
      }));
    });
    const snapshots = nodes.filter((node) => node.systemdSnapshot);
    const unavailable = snapshots.length === 0 || snapshots.every((node) => node.systemdSnapshot?.collectionStatus === "unavailable");
    const partial = snapshots.length !== nodes.length || snapshots.some((node) => node.systemdSnapshot?.collectionStatus !== "complete") || warnings.some((warning) => warning.endsWith("snapshot is stale"));
    return SystemdServicesPayloadSchema.parse({
      collectedAt: timestamps.sort().at(-1) ?? new Date().toISOString(), collectionStatus: unavailable ? "unavailable" : partial ? "partial" : "complete",
      warnings: warnings.slice(0, 100), services,
    });
  }

  async logs(unit: string) {
    try {
      const response = await this.helper({ operation: "systemd-logs", unit, limit: 100 });
      return SystemdJournalPayloadSchema.parse(response.data);
    } catch (error) { return helperFailure(error); }
  }

  async action(unit: string, action: SystemdUnitAction, idempotencyKey: string) {
    const existing = this.actions.get(idempotencyKey);
    if (existing) {
      if (existing.unit !== unit || existing.action !== action) throw new ServiceError(409, "BAD_REQUEST", "幂等键已用于其他 systemd 操作");
      return existing.result;
    }
    const result = this.helper({ operation: "systemd-action", requestId: idempotencyKey, unit, action })
      .then((response) => SystemdUnitSchema.parse(response.data?.unit))
      .catch(helperFailure);
    this.actions.set(idempotencyKey, { unit, action, result });
    if (this.actions.size > 1_000) this.actions.delete(this.actions.keys().next().value!);
    return result;
  }
}
