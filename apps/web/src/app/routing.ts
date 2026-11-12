import { useEffect } from "react";
import { navItems, pageMeta, parentPageKeys } from "./navigation";
import type { AuditSource, PageKey, QuickIntent } from "../types/app";

let pendingQuickRoute: { page: PageKey; intent: QuickIntent } | null = null;

let pendingDatabaseFocus: string | null = null;

let pendingAuditSource: AuditSource | null = null;

function consumePendingDatabaseFocus() {
  const value = pendingDatabaseFocus;
  pendingDatabaseFocus = null;
  return value;
}

function consumePendingAuditSource() {
  const value = pendingAuditSource;
  pendingAuditSource = null;
  return value;
}

const routePageAliases: Partial<Record<string, PageKey>> = {
  "hosts-all": "hosts",
  "mobile": "overview",
};

const routePageKeys = new Set<string>([
  ...parentPageKeys,
  ...Object.keys(routePageAliases),
  ...Object.keys(pageMeta),
  ...navItems.flatMap((item) => item.children.map((child) => child.page ?? child.id)),
]);

function readPageFromHash(): PageKey {
  const [key] = window.location.hash.replace("#", "").split("?");
  if (!key) return "overview";
  if (routePageKeys.has(key)) {
    const canonicalPage = routePageAliases[key] ?? key;
    if (canonicalPage !== key) {
      const nextUrl = `${window.location.pathname}${window.location.search}#${canonicalPage}`;
      window.history.replaceState(null, "", nextUrl);
    }
    return canonicalPage;
  }
  const nextUrl = `${window.location.pathname}${window.location.search}#overview`;
  window.history.replaceState(null, "", nextUrl);
  return "overview";
}

const transientRouteParamKeys = ["quick", "mobileTab", "mobileSheet", "sheetAction", "sheetTarget", "sheetLabel"];

const restorableRouteParamKeys = ["mobileTab"];

const transientRouteStateKey = "stackpilotRouteEpoch";

const transientRouteStorageKey = "stackpilot.transient-route-epoch";

const transientRouteWindowNameKey = "stackpilotTransientRouteEpoch";

let transientRoutesExpired = readStoredTransientRouteEpoch() > 0;

let currentTransientRouteEpoch = readStoredTransientRouteEpoch();

function readWindowNameTransientRouteEpoch() {
  if (typeof window === "undefined") return 0;
  const match = window.name.match(new RegExp(`(?:^|;)${transientRouteWindowNameKey}=(\\d+)(?:;|$)`));
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readStoredTransientRouteEpoch() {
  if (typeof window === "undefined") return 0;
  const fallbackEpoch = readWindowNameTransientRouteEpoch();
  try {
    const value = window.sessionStorage.getItem(transientRouteStorageKey);
    const parsed = value ? Number(value) : 0;
    return Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 0, fallbackEpoch);
  } catch {
    return fallbackEpoch;
  }
}

function storeTransientRouteEpoch(epoch: number) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(transientRouteStorageKey, String(epoch));
  } catch {
    // sessionStorage can be unavailable in restricted browser contexts.
  }
  const cleanedName = window.name
    .split(";")
    .filter((item) => item && !item.startsWith(`${transientRouteWindowNameKey}=`))
    .join(";");
  window.name = [cleanedName, `${transientRouteWindowNameKey}=${epoch}`].filter(Boolean).join(";");
}

function collectUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const [, hashQuery = ""] = window.location.hash.split("?");
  if (hashQuery) {
    new URLSearchParams(hashQuery).forEach((value, key) => {
      if (!params.has(key)) params.set(key, value);
    });
  }
  return params;
}

function hasTransientRouteParams(params: URLSearchParams) {
  return transientRouteParamKeys.some((key) => params.has(key));
}

function hasExpiredInteractionParams(params: URLSearchParams) {
  return transientRouteParamKeys.some((key) => !restorableRouteParamKeys.includes(key) && params.has(key));
}

function transientRouteEpochFromState() {
  const state = window.history.state;
  if (!state || typeof state !== "object") return null;
  const epoch = (state as Record<string, unknown>)[transientRouteStateKey];
  return typeof epoch === "number" ? epoch : null;
}

function isStaleTransientRoute(params = collectUrlParams()) {
  const storedEpoch = readStoredTransientRouteEpoch();
  if (storedEpoch > currentTransientRouteEpoch) {
    currentTransientRouteEpoch = storedEpoch;
    transientRoutesExpired = true;
  }
  if (!transientRoutesExpired || !hasTransientRouteParams(params)) return false;
  return transientRouteEpochFromState() !== currentTransientRouteEpoch;
}

function transientRouteStateFor(params: URLSearchParams) {
  return hasTransientRouteParams(params) ? { [transientRouteStateKey]: currentTransientRouteEpoch } : null;
}

function writeRouteState(historyMode: "push" | "replace", nextUrl: string, params: URLSearchParams) {
  const state = transientRouteStateFor(params);
  if (historyMode === "replace") {
    window.history.replaceState(state, "", nextUrl);
    return;
  }
  window.history.pushState(state, "", nextUrl);
}

function expireTransientRoutes() {
  transientRoutesExpired = true;
  currentTransientRouteEpoch += 1;
  storeTransientRouteEpoch(currentTransientRouteEpoch);
}

function deleteTransientRouteParams(params: URLSearchParams) {
  transientRouteParamKeys.forEach((key) => params.delete(key));
}

function deleteContextRouteParams(params: URLSearchParams) {
  params.delete("sshHost");
  params.delete("dbFocus");
  params.delete("auditSource");
}

function readUrlParams() {
  const params = collectUrlParams();
  if (isStaleTransientRoute(params)) {
    deleteTransientRouteParams(params);
  }
  return params;
}

function readDatabaseFocusParam() {
  return readUrlParams().get("dbFocus");
}

function readAuditSourceParam(): AuditSource | null {
  return readUrlParams().get("auditSource") === "database" ? "database" : null;
}

function lockedRouteForPage(page: PageKey) {
  const params = new URLSearchParams(window.location.search);
  deleteTransientRouteParams(params);
  const nextSearch = params.toString();
  return `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}#${page}`;
}

function cleanCurrentRouteForPage(page = readPageFromHash()) {
  const params = new URLSearchParams(window.location.search);
  deleteTransientRouteParams(params);
  const nextSearch = params.toString();
  return `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}#${page}`;
}

function hasHashRouteQuery() {
  return window.location.hash.includes("?");
}

function clearQuickIntent() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("quick")) return;
  params.delete("quick");
  const nextSearch = params.toString();
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", nextUrl);
}

function setQuickRoute(page: PageKey, intent: QuickIntent) {
  const params = new URLSearchParams(window.location.search);
  deleteTransientRouteParams(params);
  deleteContextRouteParams(params);
  pendingQuickRoute = { page, intent };
  const nextSearch = params.toString();
  writeRouteState("push", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}#${page}`, params);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  window.dispatchEvent(new Event("stackpilot:quick-intent"));
}

function setDatabaseFocusRoute(databaseName: string) {
  const params = new URLSearchParams(window.location.search);
  deleteTransientRouteParams(params);
  deleteContextRouteParams(params);
  params.set("dbFocus", databaseName);
  pendingDatabaseFocus = databaseName;
  const nextSearch = params.toString();
  writeRouteState("push", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}#databases`, params);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  window.dispatchEvent(new Event("stackpilot:database-focus"));
}

function setAuditSourceRoute(source: AuditSource) {
  const params = new URLSearchParams(window.location.search);
  deleteTransientRouteParams(params);
  deleteContextRouteParams(params);
  params.set("auditSource", source);
  pendingAuditSource = source;
  const nextSearch = params.toString();
  writeRouteState("push", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}#audit`, params);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  window.dispatchEvent(new Event("stackpilot:audit-source"));
}

function clearAuditSourceRoute() {
  const params = new URLSearchParams(window.location.search);
  deleteTransientRouteParams(params);
  deleteContextRouteParams(params);
  const nextSearch = params.toString();
  writeRouteState("replace", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}#audit`, params);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  window.dispatchEvent(new Event("stackpilot:audit-source"));
}

function pushPageRoute(page: PageKey) {
  const params = new URLSearchParams(window.location.search);
  deleteTransientRouteParams(params);
  deleteContextRouteParams(params);
  const nextSearch = params.toString();
  writeRouteState("push", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}#${page}`, params);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function useQuickIntent(expectedPage: PageKey, expectedIntent: QuickIntent, onIntent: () => void) {
  useEffect(() => {
    const run = () => {
      const hasPendingIntent = pendingQuickRoute?.page === expectedPage && pendingQuickRoute.intent === expectedIntent;
      if (!hasPendingIntent) return;
      pendingQuickRoute = null;
      onIntent();
      clearQuickIntent();
    };
    run();
    window.addEventListener("stackpilot:quick-intent", run);
    return () => window.removeEventListener("stackpilot:quick-intent", run);
  }, [expectedPage, expectedIntent, onIntent]);
}

export { routePageAliases, routePageKeys, readPageFromHash, transientRouteParamKeys, restorableRouteParamKeys, transientRouteStateKey, transientRouteStorageKey, transientRouteWindowNameKey, transientRoutesExpired, currentTransientRouteEpoch, readWindowNameTransientRouteEpoch, readStoredTransientRouteEpoch, storeTransientRouteEpoch, collectUrlParams, hasTransientRouteParams, hasExpiredInteractionParams, transientRouteEpochFromState, isStaleTransientRoute, transientRouteStateFor, writeRouteState, expireTransientRoutes, deleteTransientRouteParams, deleteContextRouteParams, readUrlParams, readDatabaseFocusParam, readAuditSourceParam, consumePendingDatabaseFocus, consumePendingAuditSource, lockedRouteForPage, cleanCurrentRouteForPage, hasHashRouteQuery, clearQuickIntent, setQuickRoute, setDatabaseFocusRoute, setAuditSourceRoute, clearAuditSourceRoute, pushPageRoute, useQuickIntent };
