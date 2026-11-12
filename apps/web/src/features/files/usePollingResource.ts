import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";

export function usePollingResource<T>(resourceKey: string, fetcher: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [dataKey, setDataKey] = useState("");
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const hasDataRef = useRef(false);

  const load = useCallback(async (externalSignal?: AbortSignal, silent = false) => {
    const sequence = ++sequenceRef.current;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (!silent) { setLoading(true); setError(null); }
    try {
      const payload = await fetcher(controller.signal);
      if (controller.signal.aborted || sequence !== sequenceRef.current) return;
      setData(payload); setDataKey(resourceKey); setError(null); hasDataRef.current = true;
    } catch (reason) {
      if (!controller.signal.aborted && (!silent || !hasDataRef.current)) setError(reason instanceof Error ? reason.message : "数据加载失败");
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      if (sequence === sequenceRef.current) { requestRef.current = null; setSettledKey(resourceKey); if (!silent) setLoading(false); }
    }
  }, [fetcher, resourceKey]);

  useEffect(() => {
    hasDataRef.current = false;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void load(); });
    return () => { disposed = true; requestRef.current?.abort(); };
  }, [load]);

  const visibleData = dataKey === resourceKey ? data : null;
  const visibleLoading = loading || (dataKey !== resourceKey && settledKey !== resourceKey);
  useAutoRefresh((signal) => load(signal, true), undefined, !visibleLoading);
  return { data: visibleData, loading: visibleLoading, error, reload: load };
}
