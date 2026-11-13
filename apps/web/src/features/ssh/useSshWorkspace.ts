import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHosts, type HostMonitoringRecord } from "../../api/hostsApi";
import { usePollingResource } from "../../hooks/usePollingResource";
import type { PageKey, SetPage } from "../../types/app";
import type { Permission, PublicUser } from "@stackpilot/contracts";
import { fetchSshWorkspace, fetchSshPlans } from "../../api/sshApi";

export function readSshHostId(): string | null {
  const value = new URLSearchParams(window.location.search).get("sshHost");
  return value && value.length <= 160 ? value : null;
}

export function useSshWorkspace(page: PageKey, setPage: SetPage, initialUser: PublicUser | undefined) {
  const catalogRef = useRef<HostMonitoringRecord[]>([]);
  const load = useCallback(async (signal: AbortSignal) => {
    const access = await fetchSshWorkspace(signal);
    const [plans, catalog] = await Promise.all([fetchSshPlans(signal), (access.viewer ?? initialUser)?.permissions.includes("nodes:read") ? fetchHosts(signal).then(value => { catalogRef.current = value.hosts; return { hosts: value.hosts, unavailable: false }; }).catch(error => { if (signal.aborted) throw error; return { hosts: catalogRef.current, unavailable: true }; }) : Promise.resolve({ hosts: [], unavailable: false })]);
    return { ...access, plans: plans.plans, catalog: catalog.hosts, catalogUnavailable: catalog.unavailable };
  }, [initialUser]);
  const resource = usePollingResource(load, null, !!initialUser?.permissions.includes("ssh:read"));
  const user = resource.data?.viewer ?? initialUser;
  const can = (permission: Permission, nodeId?: string) => !resource.backgroundError && !!user?.permissions.includes(permission) && (!nodeId || user.nodeScope === "all" || user.nodeScope.includes(nodeId));
  const hosts = (resource.data?.hosts ?? []).map(host => { const catalog = resource.data?.catalog.find(item => item.id === host.nodeId); return { ...host, name: catalog?.name ?? (host.address ? `${host.address}:${host.port}` : host.nodeId), environment: catalog?.environment ?? "未分组", owner: catalog?.owner ?? "—", catalog }; });
  const [hostId, setHostId] = useState<string | null>(readSshHostId);
  const [search, setSearch] = useState("");
  const [environment, setEnvironment] = useState("全部环境");
  const detailOriginRef = useRef(false);
  const detailFocusOriginRef = useRef<{ page: PageKey; hostId: string; view: string | undefined } | null>(null);

  useEffect(() => {
    if (page === "ssh-host-detail") return;
    const origin = detailFocusOriginRef.current;
    if (!origin) return;
    detailFocusOriginRef.current = null;
    if (page !== origin.page) return;
    // The overview is remounted on return, so locate the new button by entity ID.
    // Run after the drawer's unmount restoration and choose the visible layout.
    const frame = window.requestAnimationFrame(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-ssh-detail-host]"))
        .filter((button) => button.dataset.sshDetailHost === origin.hostId && !button.disabled)
        .filter((button) => {
          for (let element: HTMLElement | null = button; element; element = element.parentElement) {
            const style = window.getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || element.inert) return false;
          }
          return true;
        });
      const target = candidates.find((button) => button.dataset.sshDetailView === origin.view) ?? candidates[0];
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [page]);

  useEffect(() => {
    const sync = () => setHostId(readSshHostId());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    window.addEventListener("stackpilot:ssh-route", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("stackpilot:ssh-route", sync);
    };
  }, []);

  const navigate = useCallback((next: string, selected: string | null = hostId) => {
    const previous = new URL(window.location.href);
    const samePage = previous.hash.replace(/^#/, "").split("?")[0] === next;
    const previousHost = previous.searchParams.get("sshHost");
    setPage(next);
    const url = new URL(window.location.href);
    url.hash = next;
    if (selected) url.searchParams.set("sshHost", selected); else url.searchParams.delete("sshHost");
    if (samePage && previousHost !== selected) window.history.pushState(window.history.state, "", url);
    else window.history.replaceState(window.history.state, "", url);
    setHostId(selected);
    window.dispatchEvent(new Event("stackpilot:ssh-route"));
  }, [hostId, setPage]);

  const selectHost = (selected: string) => {
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set("sshHost", selected); else url.searchParams.delete("sshHost");
    window.history.replaceState(window.history.state, "", url);
    setHostId(selected || null);
  };
  const openDetail = (selected: string, view?: string) => {
    detailOriginRef.current = page !== "ssh-host-detail";
    if (page !== "ssh-host-detail") detailFocusOriginRef.current = { page, hostId: selected, view };
    navigate("ssh-host-detail", selected);
  };
  const closeDetail = () => {
    if (detailOriginRef.current && window.history.length > 1) { detailOriginRef.current = false; window.history.back(); }
    else navigate("ssh-hosts", null);
  };
  return { resource, hosts, user, can, hostId, search, setSearch, environment, setEnvironment, navigate, selectHost, openDetail, closeDetail };
}

export type SshWorkspace = ReturnType<typeof useSshWorkspace>;
