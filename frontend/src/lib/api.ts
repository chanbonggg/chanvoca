export async function api<T>(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
  });
  const data = await response.json().catch(() => null) as T & { error?: { message?: string } };

  if (!response.ok) throw new Error(data?.error?.message ?? "서버 요청에 실패했습니다.");

  return data;
}

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
}
