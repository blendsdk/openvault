import { useCallback, useEffect, useRef, useState } from "react";

/** One asynchronous page resource. */
export interface AsyncState<T> {
  /** Latest successful value, or undefined before the first load. */
  readonly data: T | undefined;
  /** Latest failure, or undefined. */
  readonly error: unknown;
  /** True while a request is in flight. */
  readonly loading: boolean;
  /** Re-runs the loader. */
  readonly reload: () => void;
}

/**
 * Runs one abortable loader and exposes loading, error, data, and reload.
 *
 * The loader receives an `AbortSignal`; the generated client passes it to
 * `fetch`. A stale response from a previous dependency set is ignored. The
 * `enabled` flag lets a page wait for a required id or authentication state.
 *
 * @param loader - Function that performs the request.
 * @param dependencies - Values that invalidate the request.
 * @param enabled - When false, the loader is not called.
 * @returns The resource state.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  dependencies: readonly unknown[],
  enabled = true,
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [version, setVersion] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void version;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void loaderRef
      .current(controller.signal)
      .then((value) => {
        if (controller.signal.aborted || !mounted.current) {
          return;
        }
        setData(value);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || !mounted.current) {
          return;
        }
        setError(failure);
        setLoading(false);
      });
    return () => {
      controller.abort();
    };
    // The caller owns the dependency list; version forces a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, enabled, version]);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  return { data, error, loading, reload };
}
