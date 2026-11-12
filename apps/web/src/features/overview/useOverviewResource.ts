import { useCallback, useEffect, useRef, useState } from "react";

/** Standalone pages share the same monitoring rules as OverviewDataProvider.
 * This hook is disabled inside that provider, so the shell owns the only poll.
 */
export function useOverviewResource<T>(
  request: (signal?: AbortSignal) => Promise<T>,
  enabled: boolean,
  onError: (error: unknown) => void,
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<Promise<void> | null>(null);
  const hasDataRef = useRef(false);
  const errorHandler = useRef(onError);
  useEffect(() => { errorHandler.current = onError; }, [onError]);

  const load = useCallback((silent: boolean) => {
    if (!enabled) return Promise.resolve();
    if (pendingRef.current) return pendingRef.current;
    const controller = new AbortController();
    requestRef.current = controller;
    if (!silent) { setLoading(true); setError(null); }
    const pending = request(controller.signal).then((payload) => {
      if (controller.signal.aborted) return;
      hasDataRef.current = true;
      setData(payload);
      setError(null);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (!silent || !hasDataRef.current) setError(reason instanceof Error ? reason.message : "数据加载失败");
      if (!silent) errorHandler.current(reason);
    }).finally(() => {
      if (requestRef.current === controller) {
        requestRef.current = null;
        pendingRef.current = null;
      }
      if (!controller.signal.aborted && !silent) setLoading(false);
    });
    pendingRef.current = pending;
    return pending;
  }, [enabled, request]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (disposed || document.hidden) return;
      timer = window.setTimeout(() => { void load(true).finally(schedule); }, 10_000);
    };
    const visibility = () => {
      window.clearTimeout(timer);
      if (!disposed && !document.hidden) void load(true).finally(schedule);
    };
    queueMicrotask(() => { if (!disposed) void load(false).finally(schedule); });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      requestRef.current?.abort();
      requestRef.current = null;
      pendingRef.current = null;
    };
  }, [enabled, load]);

  const replace = useCallback((payload: T) => {
    requestRef.current?.abort();
    requestRef.current = null;
    pendingRef.current = null;
    hasDataRef.current = true;
    setData(payload);
    setError(null);
    setLoading(false);
  }, []);
  const reload = useCallback(() => load(false), [load]);
  return { data, loading, error, reload, replace };
}
