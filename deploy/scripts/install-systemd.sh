#!/bin/sh
set -eu

component=${1:-}
case "$component" in controller|agent|cert-helper|mesh-helper) ;; *) echo "Usage: install-systemd.sh controller|agent|cert-helper|mesh-helper" >&2; exit 1;; esac
[ "$(id -u)" -eq 0 ] || { echo "Installation requires root; services still run as dedicated non-root users." >&2; exit 1; }

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
version=$(node -p "require('$root/package.json').version")
case "$component" in
  controller) prefix=/opt/stackpilot; units="stackpilot-controller.service"; entry=apps/controller/dist/server.js; workspace=@stackpilot/controller ;;
  agent) prefix=/opt/stackpilot-agent; units="stackpilot-agent.service"; entry=apps/agent/dist/main.js; workspace=@stackpilot/agent ;;
  cert-helper) prefix=/opt/stackpilot-cert-helper; units="stackpilot-cert-helper.socket stackpilot-cert-helper@.service stackpilot-firewall-helper.socket stackpilot-firewall-helper@.service"; entry=apps/cert-helper/dist/main.js; workspace=@stackpilot/cert-helper ;;
  mesh-helper) prefix=/opt/stackpilot-mesh-helper; units="stackpilot-mesh-helper.socket stackpilot-mesh-helper@.service"; entry=apps/mesh-helper/dist/main.js; workspace=@stackpilot/mesh-helper ;;
esac
required_entries=$entry
if [ "$component" = "cert-helper" ]; then
  required_entries="$required_entries apps/cert-helper/dist/firewallMain.js"
fi
release="$prefix/releases/$version"
staging="$release.installing.$$"

verify_component_release() {
  candidate=$1
  description=$2
  [ -f "$candidate/package.json" ] || { echo "$description is incomplete: $candidate" >&2; exit 1; }
  for required_entry in $required_entries; do
    [ -f "$candidate/$required_entry" ] || { echo "$description is incomplete: $candidate" >&2; exit 1; }
  done
  if [ "$component" = "controller" ]; then
    [ -f "$candidate/apps/web/dist/index.html" ] || { echo "$description is missing Web assets: $candidate" >&2; exit 1; }
  fi
}

copy_path() {
  source=$1
  target=$2
  [ -e "$root/$source" ] || { echo "Release input is missing: $source" >&2; exit 1; }
  install -d -m 0755 "$staging/$(dirname "$target")"
  cp -R "$root/$source" "$staging/$target"
}

stage_component() {
  install -d -m 0755 "$staging"
  copy_path package.json package.json
  copy_path package-lock.json package-lock.json
  copy_path "apps/$component/package.json" "apps/$component/package.json"
  copy_path "apps/$component/dist" "apps/$component/dist"
  case "$component" in
    controller)
      copy_path apps/web/package.json apps/web/package.json
      copy_path apps/web/dist apps/web/dist
      copy_path packages/config/package.json packages/config/package.json
      copy_path packages/config/src packages/config/src
      copy_path packages/contracts/package.json packages/contracts/package.json
      copy_path packages/contracts/dist packages/contracts/dist
      copy_path packages/host-telemetry/package.json packages/host-telemetry/package.json
      copy_path packages/host-telemetry/dist packages/host-telemetry/dist
      ;;
    agent)
      copy_path packages/contracts/package.json packages/contracts/package.json
      copy_path packages/contracts/dist packages/contracts/dist
      copy_path packages/host-telemetry/package.json packages/host-telemetry/package.json
      copy_path packages/host-telemetry/dist packages/host-telemetry/dist
      ;;
  esac
}

install_units() {
  for unit_file in $units; do
    unit_source="$root/deploy/systemd/$unit_file"
    unit_target="/etc/systemd/system/$unit_file"
    if [ ! -f "$unit_target" ] || ! cmp -s "$unit_source" "$unit_target"; then
      install -m 0644 "$unit_source" "$unit_target"
    fi
  done
  if [ "$component" = "cert-helper" ] || [ "$component" = "mesh-helper" ]; then
    install -m 0644 "$root/deploy/systemd/stackpilot-$component.tmpfiles" "/etc/tmpfiles.d/stackpilot-$component.conf"
    systemd-tmpfiles --create "/etc/tmpfiles.d/stackpilot-$component.conf"
  fi
  systemctl daemon-reload
}

prepare_controller_host() {
  [ "$component" = "controller" ] || return 0
  [ -x /usr/bin/crontab ] || { echo "Controller installation requires executable /usr/bin/crontab. Install the Debian/Ubuntu cron package and retry." >&2; exit 1; }
  command -v getent >/dev/null 2>&1 || { echo "Controller installation requires getent to verify the system crontab group. Install the Debian/Ubuntu libc-bin package and retry." >&2; exit 1; }
  getent group crontab >/dev/null 2>&1 || { echo "Controller installation requires the existing system crontab group. Install the Debian/Ubuntu cron package and retry." >&2; exit 1; }
  [ -d /var/spool/cron/crontabs ] || { echo "Controller installation requires /var/spool/cron/crontabs. Install or repair the Debian/Ubuntu cron package and retry." >&2; exit 1; }
  systemd-sysusers "$root/deploy/systemd/stackpilot-controller.sysusers"
}

prepare_controller_host

if [ -e "$release" ]; then
  [ -d "$release" ] && [ ! -L "$release" ] || { echo "Existing release is not a regular directory: $release" >&2; exit 1; }
  verify_component_release "$release" "Existing release"
  [ -L "$prefix/current" ] && [ "$(readlink -f "$prefix/current")" = "$(readlink -f "$release")" ] || { echo "Existing release is not the current release: $release" >&2; exit 1; }
  install_units
  echo "Release already installed: $release; systemd units synchronized without changing the release, current link or service state. Restart the installed component explicitly to apply unit changes."
  exit 0
fi

if [ "$component" != "controller" ]; then
  systemd-sysusers "$root/deploy/systemd/stackpilot-${component}.sysusers"
fi
install -d -m 0755 "$prefix/releases"
rm -rf "$staging"
trap 'rm -rf "$staging"' EXIT HUP INT TERM
stage_component
(cd "$staging" && npm ci --omit=dev --workspace "$workspace" --include-workspace-root)
verify_component_release "$staging" "Staged release"
chown -R root:root "$staging"
chmod -R go-w "$staging"
mv "$staging" "$release"
trap - EXIT HUP INT TERM
ln -sfn "$release" "$prefix/current.next"
mv -Tf "$prefix/current.next" "$prefix/current"
install_units
if [ "$component" = "cert-helper" ]; then
  if [ ! -f /etc/stackpilot-site-helper/runtimes.json ]; then
    install -m 0644 "$root/deploy/examples/site-helper-runtimes.json" /etc/stackpilot-site-helper/runtimes.json
  fi
  if [ ! -f /etc/stackpilot-site-helper/helper.env ]; then
    install -m 0600 "$root/deploy/examples/site-helper.env.example" /etc/stackpilot-site-helper/helper.env
  fi
  echo "Installed $component $version. Enable the local-only sockets: systemctl enable --now stackpilot-cert-helper.socket stackpilot-firewall-helper.socket"
elif [ "$component" = "mesh-helper" ]; then
  echo "Installed $component $version. Enable the local-only socket: systemctl enable --now stackpilot-mesh-helper.socket"
else
  echo "Installed $component $version. Configure /etc before running: systemctl enable --now stackpilot-$component.service"
fi
