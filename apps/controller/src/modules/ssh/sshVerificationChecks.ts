export const SSH_VERIFICATION_CHECKS = ["authentication.pam", "authentication.reuse-denied", "authentication.expired-denied", "authentication.revoked-denied", "authentication.other-account-denied", "authentication.other-node-denied", "authentication.old-key-denied", "authentication.password-method-denied", "identity.uid", "sudo.profile", "session.local-deadline", "forwarding.disabled", "sftp.session", "entrances.effective-configuration"] as const;
export function completeSshEvidence(evidence: { check: string; passed: boolean }[]) {
  return evidence.every(value => value.passed) && SSH_VERIFICATION_CHECKS.every(check => evidence.some(value => value.check === check && value.passed));
}
