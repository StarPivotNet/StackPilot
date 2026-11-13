import { randomUUID } from "node:crypto";
import { checkSudoListing, type SshTakeoverPlan } from "@stackpilot/contracts";
import { connectSshProbe, SshProbeError, type SshProbeAuth } from "./sshProbeClient.js";
import type { SshService } from "./sshService.js";

const expected = { authenticationmethods: "keyboard-interactive:pam", passwordauthentication: "no", pubkeyauthentication: "no", kbdinteractiveauthentication: "yes", usepam: "yes", hostbasedauthentication: "no", gssapiauthentication: "no", kerberosauthentication: "no", permitrootlogin: "no", authorizedkeysfile: "none", authorizedkeyscommand: "none", authorizedprincipalsfile: "none", authorizedprincipalscommand: "none", trustedusercakeys: "none", allowusers: "sp_*", denyusers: "root", disableforwarding: "yes", allowtcpforwarding: "no", allowstreamlocalforwarding: "no", allowagentforwarding: "no", x11forwarding: "no", permittunnel: "no", permituserenvironment: "no", permituserrc: "no", subsystem: "sftp internal-sftp" };
export class SshVerificationError extends Error {
  constructor(readonly evidence: SshTakeoverPlan["evidence"], readonly code: string) { super(code); }
}
export class SshTakeoverVerifier {
  constructor(private readonly ssh: SshService) {}
  async verify(plan: SshTakeoverPlan, legacyKey: string) {
    if (!plan.inventory || !plan.appliedInventory || !plan.binding || !plan.local?.appliedDigest || plan.appliedInventory.digest !== plan.local.appliedDigest) throw new Error("Missing native SSH application evidence");
    for (const [key, value] of Object.entries(expected)) if (plan.appliedInventory.authentication[key]?.join(" ") !== value) throw new Error("Managed SSH effective configuration does not match");
    if (plan.appliedInventory.matches.length) throw new Error("Managed SSH still inherits Match rules");
    const endpoint = { address: plan.address, port: plan.port, account: plan.binding.account, fingerprints: plan.inventory.fingerprints };
    const evidence: SshTakeoverPlan["evidence"] = [], pass = (check: string) => evidence.push({ check, passed: true, collectedAt: new Date().toISOString() });
    pass("entrances.effective-configuration");
    const rejectAuth = async (auth: SshProbeAuth, account = endpoint.account) => {
      let accepted;
      try { accepted = await connectSshProbe({ ...endpoint, account }, auth); }
      catch (error) { if (error instanceof SshProbeError && error.code === "SSH_AUTH_REJECTED") return; throw error; }
      accepted.destroy(); throw new Error("An invalid SSH authentication source was accepted");
    };
    const issued = this.ssh.issueVerification(plan.id);
    if (issued.policy.id !== plan.binding.policyId || issued.policy.revision !== plan.binding.revision || issued.policy.systemUid !== plan.binding.uid) throw new Error("SSH policy changed before verification");
    let positive;
    try {
      positive = await connectSshProbe(endpoint, { method: "keyboard-interactive", password: issued.password });
      pass("authentication.pam");
      const session = this.ssh.verificationSession(issued.credential.id); if (!session || session.nodeId !== plan.nodeId || session.account !== plan.binding.account) throw new Error("SSH connection was not bound to its credential");
      const uid = await positive.exec("identity"); if (uid.code !== 0 || uid.stdout.trim() !== String(plan.binding.uid)) throw new Error("SSH login has an unexpected UID"); pass("identity.uid");
      const sudo = await positive.exec("sudoListing"), root = await positive.exec("sudoIdentity");
      if (issued.policy.profile === "shell") {
        // Unlike root's sudo -l -U inspection performed by the helper before
        // PAM authentication, an unprivileged sudo -l may require a password
        // even when the account has no grants. Both actual invocations must
        // still be denied; the helper has already rejected inherited grants.
        const listing = `${sudo.stdout}${sudo.stderr}`.trim();
        const noGrants = new RegExp(`^User ${endpoint.account} is not allowed to run sudo on [^\\n]+\\.$`).test(listing);
        const needsPassword = sudo.code === 1 && !sudo.stdout && sudo.stderr.trim() === "sudo: a password is required";
        if (root.code !== 1 || (!noGrants && !needsPassword)) throw new Error("Ordinary SSH shell has sudo privileges");
      }
      else { checkSudoListing(issued.policy, sudo.stdout); if (issued.policy.profile === "host-admin" ? root.code !== 0 || root.stdout.trim() !== "0" : root.code === 0) throw new Error("SSH sudo profile does not match"); }
      pass("sudo.profile");
      await positive.inspectSftp(); pass("sftp.session");
      if (!await positive.forwardingDenied()) throw new Error("SSH forwarding was not administratively prohibited"); pass("forwarding.disabled");
      await rejectAuth({ method: "keyboard-interactive", password: issued.password }); pass("authentication.reuse-denied");
      await rejectAuth({ method: "publickey", privateKey: legacyKey }); pass("authentication.old-key-denied");
      await rejectAuth({ method: "password", password: issued.password }); pass("authentication.password-method-denied");
      for (const type of ["expired", "revoked"] as const) { const sample = this.ssh.issueVerification(plan.id, type); await rejectAuth({ method: "keyboard-interactive", password: sample.password }); pass(`authentication.${type}-denied`); }
      const bound = this.ssh.issueVerification(plan.id);
      await rejectAuth({ method: "keyboard-interactive", password: bound.password }, "sp_invalid_probe_user"); pass("authentication.other-account-denied");
      let rejectedNode = false;
      try { this.ssh.authenticate(randomUUID(), endpoint.account, bound.password, randomUUID()); } catch { rejectedNode = true; }
      if (!rejectedNode || this.ssh.verificationSession(bound.credential.id)) throw new Error("Cross-node SSH credential binding failed"); pass("authentication.other-node-denied");
      const expires = Date.parse(session.expiresAt), timeoutMs = Math.max(1, expires + 8000 - Date.now()); let timer: NodeJS.Timeout | undefined;
      let closed: number;
      try { closed = await Promise.race([positive.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SSH connection exceeded its local deadline")), timeoutMs); })]); } finally { clearTimeout(timer); }
      if (closed < expires - 5500 || closed > expires + 8000) throw new Error("SSH connection closed outside its verified lease window");
      pass("session.local-deadline"); return evidence;
    } catch (error) { throw new SshVerificationError(evidence, error instanceof SshProbeError ? error.code : "SSH_VERIFICATION_FAILED"); }
    finally { positive?.destroy(); this.ssh.revokeVerification(plan.id); }
  }
}
