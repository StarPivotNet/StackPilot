#!/bin/sh
set -eu
mode=${1:-program-only}
systemctl disable --now stackpilot-cert-helper.socket stackpilot-firewall-helper.socket stackpilot-mesh-helper.socket stackpilot-controller.service stackpilot-agent.service 2>/dev/null || true
systemctl stop 'stackpilot-cert-helper@*.service' 'stackpilot-firewall-helper@*.service' 'stackpilot-mesh-helper@*.service' 2>/dev/null || true
rm -rf /opt/stackpilot /opt/stackpilot-agent /opt/stackpilot-cert-helper /opt/stackpilot-mesh-helper /run/stackpilot-cert-helper /run/stackpilot-firewall-helper /run/stackpilot-mesh
rm -f /etc/systemd/system/stackpilot-cert-helper.socket /etc/systemd/system/stackpilot-cert-helper@.service /etc/systemd/system/stackpilot-firewall-helper.socket /etc/systemd/system/stackpilot-firewall-helper@.service /etc/systemd/system/stackpilot-mesh-helper.socket /etc/systemd/system/stackpilot-mesh-helper@.service /etc/tmpfiles.d/stackpilot-cert-helper.conf /etc/tmpfiles.d/stackpilot-mesh-helper.conf
systemctl daemon-reload
if [ "$mode" = "destroy-data" ]; then
  [ "${STACKPILOT_CONFIRM_DESTROY:-}" = "DESTROY-STACKPILOT-DATA" ] || { echo "Refusing data destruction without STACKPILOT_CONFIRM_DESTROY=DESTROY-STACKPILOT-DATA" >&2; exit 1; }
  rm -rf /var/lib/stackpilot-controller /var/lib/stackpilot-agent /var/lib/stackpilot-mesh /etc/stackpilot /etc/stackpilot-agent
elif [ "$mode" != "program-only" ]; then echo "Usage: uninstall.sh [program-only|destroy-data]" >&2; exit 1; fi
