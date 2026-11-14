import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
export function useApi<T>(path: string | null, key: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) { setData(null); setError(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(null);
    api<T>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(reason => {
      if (!controller.signal.aborted) { setError(reason); setData(null); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision, key]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  return { data, error, loading, refresh, setData };
}
export function useDebounced<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return debounced;
}
