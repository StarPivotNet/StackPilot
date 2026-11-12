type LiveTerminalSession = { id: string; host: string; ip: string; user: string; cwd: string; status: "connected" | "disconnected"; latency: string; startedAt: string; lastCommand: string; privilege: "user" | "unknown" };
type LiveTerminalHistory = { id: string; nodeId: string; command: string; host: string; user: string; status: "成功" | "失败" | "执行中"; duration: string; time: string; output: string };

export type { LiveTerminalHistory, LiveTerminalSession };
