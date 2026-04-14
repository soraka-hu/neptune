const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
};

export async function apiClient<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    let message = `API request failed: ${response.status}`;
    try {
      const errorBody = (await response.json()) as { message?: unknown } | null;
      if (errorBody && typeof errorBody.message === "string" && errorBody.message.trim()) {
        message = errorBody.message.trim();
      }
    } catch {
      // ignore non-JSON error payloads
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}
