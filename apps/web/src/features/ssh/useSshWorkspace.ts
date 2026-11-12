import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHosts } from "../../api/hostsApi";
import { usePollingResource } from "../../hooks/usePollingResource";
import type { PageKey, SetPage } from "../../types/app";
import { emptySshDraft, type SshDraft, type SshDraftKind } from "./model";

export function readSshHostId(): string | null {
  const value = new URLSearchParams(window.location.search).get("sshHost");
  return value && value.length <= 160 ? value : null;
}

export function useSshWorkspace(page: PageKey, setPage: SetPage) {
  const load = useCallback((signal: AbortSignal) => fetchHosts(signal), []);
  const resource = usePollingResource(load);
  const [hostId, setHostId] = useState<string | null>(readSshHostId);
  const [search, setSearch] = useState("");
  const [environment, setEnvironment] = useState("全部环境");
  const [drafts, setDrafts] = useState<Record<SshDraftKind, SshDraft>>(() => ({ takeover: emptySshDraft("takeover"), issue: emptySshDraft("issue"), policy: emptySshDraft("policy"), rescue: emptySshDraft("rescue") }));
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
  const draftFor = (kind: SshDraftKind): SshDraft => {
    const current = drafts[kind];
    return hostId && current.hostId !== hostId ? { ...emptySshDraft(kind), hostId } : current;
  };
  const updateDraft = (kind: SshDraftKind, next: SshDraft) => setDrafts((current) => ({ ...current, [kind]: next }));
  const resetDraft = (kind: SshDraftKind) => setDrafts((current) => ({ ...current, [kind]: { ...emptySshDraft(kind), hostId: hostId ?? "" } }));

  return { resource, hosts: resource.data?.hosts ?? [], hostId, search, setSearch, environment, setEnvironment, navigate, selectHost, openDetail, closeDetail, draftFor, updateDraft, resetDraft };
}

export type SshWorkspace = ReturnType<typeof useSshWorkspace>;
