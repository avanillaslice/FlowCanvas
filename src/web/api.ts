export interface BrowserSession {
  id: string;
  token: string;
  shared: boolean;
  generation: number;
  selection: import("../shared/model.js").Selection;
}
let session: BrowserSession;
export function setSession(value: BrowserSession) {
  session = value;
}
export function getSession() {
  return session;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session
        ? { "x-session-id": session.id, "x-session-token": session.token }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      result.code ?? "request_failed",
      result.message ?? "Could not reach FlowCanvas.",
      result.details,
    );
  return result;
}
export const operationId = () => crypto.randomUUID();
