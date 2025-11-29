// lib/authedFetch.ts
export async function authedFetch(input: RequestInfo, init: RequestInit = {}) {
  const headers = new Headers(init.headers as any);
  if (typeof window !== "undefined") {
    const passkey =
      localStorage.getItem("site_passkey") ||
      document.cookie
        .split("; ")
        .find((c) => c.startsWith("site_passkey="))
        ?.split("=")[1];
    if (passkey) headers.set("x-passkey", passkey);
  }
  return fetch(input, { ...init, headers });
}

export function logoutPasskey() {
  if (typeof window === "undefined") return;

  // Remove from localStorage
  localStorage.removeItem("site_passkey");

  // Remove from cookies (both Secure and non-Secure versions)
  document.cookie = "site_passkey=; Max-Age=0; Path=/; SameSite=Lax; Secure";
  document.cookie = "site_passkey=; Max-Age=0; Path=/; SameSite=Lax;";

  // Reload to trigger middleware protection
  window.location.reload();
}
