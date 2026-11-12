import { realpath } from "node:fs/promises";
import { rootDirectory, rootFile, rootExecutable } from "./files.js";
import { dirname } from "node:path";
import { runCommand, type CommandRunner } from "./commands.js";
import { validateServiceUnit } from "./sudoPolicy.js";

/** Restricted operations may not start processes with root identity/capabilities.
 * Full host administration is a separate, explicit policy profile. */
export class ServiceInspector {
  constructor(private readonly run: CommandRunner = runCommand) {}
  async validate(unit: string) {
    validateServiceUnit(unit);
    const text = await this.run("/usr/bin/systemctl", ["show", "--no-pager", "--property=User,Group,SupplementaryGroups,NoNewPrivileges,AmbientCapabilities,CapabilityBoundingSet,FragmentPath,DropInPaths,ExecStartEx,ExecStartPreEx,ExecStartPostEx,ExecStopEx,ExecStopPostEx,ExecReloadEx,OnFailure,OnSuccess,FailureAction,SuccessAction,StartLimitAction,JobTimeoutAction,PropagatesStopTo,Conflicts,Requires,Wants,Requisite,BindsTo,Upholds,PartOf,PropagatesReloadTo,DefaultDependencies", "--", unit]);
    const values = Object.fromEntries(text.trim().split("\n").map(line => { const equal = line.indexOf("="); if (equal < 0) throw new Error("Invalid systemd metadata"); return [line.slice(0, equal), line.slice(equal + 1)]; }));
    const user = values.User;
    for (const key of ["User", "Group", "SupplementaryGroups", "NoNewPrivileges", "AmbientCapabilities", "CapabilityBoundingSet", "FragmentPath", "DropInPaths", "ExecStartEx", "FailureAction", "SuccessAction", "StartLimitAction", "JobTimeoutAction"]) if (!(key in values)) throw new Error("Incomplete systemd security metadata");
    for (const key of ["FailureAction", "SuccessAction", "StartLimitAction", "JobTimeoutAction"]) if (values[key] !== "none") throw new Error("Service can trigger privileged host actions");
    if (values.DefaultDependencies !== "no") throw new Error("Restricted services must declare their lifecycle explicitly");
    if (values.Requires && values.Requires !== "system.slice") throw new Error("Service has unsupported required dependencies");
    for (const key of ["OnFailure", "OnSuccess", "PropagatesStopTo", "Conflicts", "Wants", "Requisite", "BindsTo", "Upholds", "PartOf", "PropagatesReloadTo"]) if (values[key]) throw new Error(`Service has unsupported lifecycle propagation (${key})`);
    if (!user || !/^[a-z_][a-z0-9_-]*$/.test(user) || user === "root" || values.NoNewPrivileges !== "yes" || values.AmbientCapabilities || values.CapabilityBoundingSet || values.SupplementaryGroups || (values.Group && values.Group !== user)) throw new Error("Service does not meet restricted operation requirements");
    const identity = (await this.run("/usr/bin/getent", ["passwd", user])).trim().split(":");
    if (identity.length !== 7 || identity[0] !== user || !/^\d+$/.test(identity[2] ?? "") || !/^\d+$/.test(identity[3] ?? "") || Number(identity[2]) <= 0 || Number(identity[3]) <= 0) throw new Error("Service identity is not isolated");
    const groups = (await this.run("/usr/bin/id", ["-G", user])).trim().split(/\s+/).map(Number);
    if (groups.length !== 1 || groups[0] !== Number(identity[3]) || (await this.run("/usr/bin/getent", ["group", identity[3]!])).split(":")[0] !== user) throw new Error("Service has privileged or shared group membership");
    const files = [values.FragmentPath, ...(values.DropInPaths ? values.DropInPaths.split(" ") : [])];
    for (const file of files) {
      if (!file || !file.startsWith("/etc/systemd/system/") && !file.startsWith("/usr/lib/systemd/system/") && !file.startsWith("/lib/systemd/system/")) throw new Error("Unsupported service unit location");
      const path = await realpath(file); await rootDirectory(dirname(path)); const source = (await rootFile(path)).replace(/\\\r?\n/g, " ");
      if (/^\s*(?:Include\s*=|PermissionsStartOnly\s*=\s*yes|Exec\w+\s*=\s*[-@:]*(?:\+|!))/m.test(source)) throw new Error("Privileged service command modifiers are not allowed");
    }
    for (const [key, value] of Object.entries(values)) if (key.startsWith("Exec")) {
      if (/privileged|no-setuid|ambient/.test(value)) throw new Error("Service overrides privilege isolation");
      for (const match of value.matchAll(/path=([^ ;]+)/g)) { const binary = await realpath(match[1]!); await rootDirectory(dirname(binary)); await rootExecutable(binary); }
    }
  }
}
