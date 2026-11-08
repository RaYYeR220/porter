import type { Author, RunDetail, RunsPage } from "./types";

export type ApiOk<T> = { ok: true; status: number; data: T };
export type ApiFail = { ok: false; status: number; error: string; reason: string | null };
export type ApiResult<T> = ApiOk<T> | ApiFail;

/** fetch → a typed result. Never throws: a network failure is status 0, "network". */
export async function request<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  } catch {
    return { ok: false, status: 0, error: "network", reason: null };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; reason?: unknown };
  return {
    ok: false,
    status: res.status,
    error: typeof b.error === "string" ? b.error : "error",
    reason: typeof b.reason === "string" ? b.reason : null,
  };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const fetchRun = (id: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
export const fetchRuns = (q: { limit?: number; cursor?: string | null } = {}) => {
  const p = new URLSearchParams({ limit: String(q.limit ?? 50) });
  if (q.cursor) p.set("cursor", q.cursor);
  return request<RunsPage>(`/api/runs?${p}`);
};
export const fetchAuthors = () => request<{ authors: Author[] }>("/api/authors");
export const submitTry = (body: { preset: string } | { title: string; body: string }) =>
  request<{ runId?: string; runIds?: string[] }>("/api/try", post(body));
export const postAuthorAction = (id: string, action: string) =>
  request<{ ok: true }>(`/api/authors/${encodeURIComponent(id)}`, post({ action }));
export const postProposalDecision = (id: number, decision: "approve" | "reject") =>
  request<{ ok: true; status: string }>(`/api/proposals/${id}`, post({ decision }));

export type Notice = { title: string; body: string };

/** Calm, specific copy for a failed call. `what` names the action ("filing", "author", "proposal"). */
export function noticeFor(f: ApiFail, what: "try" | "author" | "proposal" | "read"): Notice {
  if (f.status === 0) return { title: "Porter can’t be reached", body: "Check your connection and try again in a moment." };
  if (f.status === 429) {
    return what === "try"
      ? { title: "That’s the limit for this hour", body: "This page takes a few test issues an hour from each address. Try again in an hour, or read past runs in the console." }
      : { title: "That’s the limit for this hour", body: "Console actions are limited per address each hour. Try again in an hour." };
  }
  if (f.status === 503 && f.error === "paused") {
    return {
      title: "Paused while the balance is low",
      body: "Porter’s Otari balance is below the floor that keeps the demo safe, so new test issues are not accepted. Runs already filed still finish, and the console still works.",
    };
  }
  if (f.status === 503) {
    return what === "proposal" && f.reason?.includes("tool server")
      ? { title: "The tool server is not available", body: "Nothing was executed and the proposal stays pending. Try again later." }
      : { title: "Not connected yet", body: f.reason ? `${f.reason} The console still shows past runs.` : "This part of the demo is not configured yet." };
  }
  if (f.status === 400) return { title: "Check the issue", body: f.reason ? `${capital(f.reason)}.` : "The request was not accepted." };
  if (f.status === 413) return { title: "Too long", body: "Shorten the issue and file it again." };
  if (f.status === 404) {
    if (what === "author") return { title: "Unknown author", body: "The gateway has no record of this author." };
    return { title: "Not found", body: what === "read" ? "There is no run with this id." : "It no longer exists." };
  }
  if (f.status === 403) return { title: "Not allowed here", body: f.reason ? `${capital(f.reason)}.` : "Only the demo repository is managed from this console." };
  if (f.status === 409) return { title: "Already decided", body: "Someone made a decision on this first." };
  if (f.status === 502) return { title: "The tool call failed", body: f.reason ?? "The error is recorded on the run." };
  return { title: "Something went wrong", body: "Porter could not complete that. Try again in a moment." };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
