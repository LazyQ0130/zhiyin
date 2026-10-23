"use client";

import { useCallback, useEffect, useState } from "react";
import type { ListDTO } from "@/lib/contracts";

export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); this.name = "ApiError"; }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/v1${path}`, { ...init, credentials: "same-origin", headers });
  const body = await response.json().catch(() => null) as { data?: T; error?: { code: string; message: string } } | null;
  if (!response.ok || !body || body.error) throw new ApiError(body?.error?.message ?? "暂时无法连接学习空间，请稍后重试。", body?.error?.code ?? "NETWORK_ERROR", response.status);
  return body.data as T;
}
export function mutate<T>(path: string, body: unknown = {}, method = "POST", idempotencyKey?: string) {
  return api<T>(path, { method, body: JSON.stringify(body), headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined });
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作没有完成，请重试。"; }
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let active = true;
    void api<T>(path, { signal: controller.signal }).then((value) => { if (active) { setData(value); setError(null); setLoading(false); } }).catch((reason: unknown) => {
      if (active) { setError(reason instanceof Error ? reason : new Error(errorMessage(reason))); setLoading(false); }
    });
    return () => { active = false; controller.abort(); };
  }, [path, version]);
  return { data, setData, error, loading, reload };
}

export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }, composing: boolean) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229;
}

export function usePagedApi<T>(path: string) {
  const result = useApi<ListDTO<T>>(path);
  const [pages, setPages] = useState<{ path: string; items: T[]; nextCursor: string | null }>({ path: "", items: [], nextCursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  const nextCursor = pages.path === path ? pages.nextCursor : result.data?.nextCursor;
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); setPageError("");
    try { const page = await api<ListDTO<T>>(`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(nextCursor)}`); setPages((previous) => ({ path, items: [...(previous.path === path ? previous.items : []), ...page.items], nextCursor: page.nextCursor })); }
    catch (error) { setPageError(errorMessage(error)); }
    finally { setLoadingMore(false); }
  }
  return { ...result, data: result.data ? { items: [...result.data.items, ...(pages.path === path ? pages.items : [])], nextCursor: nextCursor ?? null } : null, loadingMore, loadMore, pageError };
}
