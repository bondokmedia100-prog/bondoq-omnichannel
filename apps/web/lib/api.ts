export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export function getToken() { return typeof window === "undefined" ? "" : localStorage.getItem("bondoq_token") || ""; }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `تعذر إكمال الطلب (${response.status})`, response.status);
  return body;
}
