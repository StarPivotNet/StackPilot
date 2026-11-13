import type { AgentNodeRecord, RemoteTaskRecord, RemoteTaskStatus } from "@stackpilot/contracts";

type TerminalHistoryStatus = "等待" | "运行中" | "成功" | "失败" | "取消" | "过期";
type TerminalHistoryView = {
  id: string; host: string; action: string; taskType: string; actor: string; status: TerminalHistoryStatus;
  tone: "blue" | "orange" | "green" | "red" | "gray"; duration: string; createdAt: string;
  updatedAt: string; output: string; truncated: boolean; traceId: string;
};

const statuses: Record<RemoteTaskStatus, Pick<TerminalHistoryView, "status" | "tone">> = {
  queued: { status: "等待", tone: "blue" }, dispatched: { status: "等待", tone: "blue" },
  running: { status: "运行中", tone: "orange" }, succeeded: { status: "成功", tone: "green" },
  failed: { status: "失败", tone: "red" }, cancelled: { status: "取消", tone: "gray" }, expired: { status: "过期", tone: "gray" },
};

function actionLabel(task: RemoteTaskRecord) {
  if (task.type === "network.mesh.status.read") return "读取组网状态";
  if (task.type === "system.summary.read") return "读取系统摘要";
  if (task.type === "terminal.command.execute") {
    if (task.parameters.command === "disk-usage") return "执行 df -h";
    if (task.parameters.command === "uptime") return "执行 uptime";
    if (task.parameters.command === "top-summary") return "执行 top";
    if (task.parameters.command === "service-status") return `执行 systemctl status ${String(task.parameters.serviceName)}`;
    return "执行受控终端命令";
  }
  const serviceName = typeof task.parameters.serviceName === "string" ? task.parameters.serviceName : "";
  return `读取服务状态${serviceName ? ` · ${serviceName}` : ""}`;
}

function durationLabel(task: RemoteTaskRecord) {
  const elapsedMs = Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.createdAt));
  if (elapsedMs < 1_000) return `${elapsedMs}ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  return `${Math.floor(elapsedMs / 60_000)}m ${Math.round((elapsedMs % 60_000) / 1_000)}s`;
}

function terminalHistoryView(task: RemoteTaskRecord, nodes: AgentNodeRecord[]): TerminalHistoryView {
  const state = statuses[task.status];
  return {
    id: task.taskId, host: nodes.find((node) => node.nodeId === task.targetNodeId)?.nodeName ?? task.targetNodeId,
    action: actionLabel(task), taskType: task.type, actor: task.requester, status: state.status, tone: state.tone,
    duration: durationLabel(task), createdAt: task.createdAt, updatedAt: task.updatedAt,
    output: task.result?.message ?? task.errorCode ?? (task.status === "succeeded" ? "任务已完成" : "等待 Agent 返回结果"),
    truncated: task.result?.truncated ?? false, traceId: task.traceId,
  };
}

export { terminalHistoryView };
export type { TerminalHistoryView };
