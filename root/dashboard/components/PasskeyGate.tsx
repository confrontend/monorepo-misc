"use client";

import { useEffect, useMemo, useState } from "react";

function isLocked() {
  // Middleware sets this header; on client we can’t read response headers directly,
  // so we infer lock by checking a small ping to a public path.
  // Simpler approach: check cookie against localStorage and allow UI to decide.
  return typeof window !== "undefined" && !getStoredPasskey();
}

function getStoredPasskey() {
  if (typeof window === "undefined") return null;
  const ls = localStorage.getItem("site_passkey");
  const ck = document.cookie
    .split("; ")
    .find((c) => c.startsWith("site_passkey="))
    ?.split("=")[1];
  return ls || ck || null;
}

function setPasskeyEverywhere(key: string) {
  // localStorage
  localStorage.setItem("site_passkey", key);
  // cookie (readable by client; middleware will accept it)
  document.cookie = `site_passkey=${key}; Max-Age=${60 * 60 * 24 * 7}; Path=/; SameSite=Lax; Secure`;
}

export default function PasskeyGate({ children }: { children: React.ReactNode }) {
  const [hasKey, setHasKey] = useState<boolean>(() => !!getStoredPasskey());
  const [value, setValue] = useState("");

  useEffect(() => {
    // re-check on mount (in case of cookie-only)
    setHasKey(!!getStoredPasskey());
  }, []);

  const locked = useMemo(() => !hasKey, [hasKey]);

  if (!locked) return <>{children}</>;

  return (
    <div className="min-h-screen grid place-items-center bg-neutral-50">
      <div className="w-full max-w-sm rounded-2xl border bg-white shadow p-6 space-y-4">
        <h1 className="text-lg font-semibold">Enter Passkey</h1>
        <input
          type="password"
          className="w-full border rounded-md px-3 py-2"
          placeholder="Passkey"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (document.getElementById("passkey-submit") as HTMLButtonElement)?.click();
            }
          }}
        />
        <button
          id="passkey-submit"
          className="w-full rounded-md border px-3 py-2 font-medium hover:bg-neutral-50"
          onClick={() => {
            const key = value.trim();
            if (!key) return;
            setPasskeyEverywhere(key);
            // Quick probe fetch to verify; if rejected, reset
            fetch("/api/health?probe=1", {
              headers: { "x-passkey": key },
            })
              .then(() => setHasKey(true))
              .catch(() => {
                localStorage.removeItem("site_passkey");
                document.cookie = "site_passkey=; Max-Age=0; Path=/";
                alert("Invalid passkey.");
              });
          }}
        >
          Continue
        </button>
        <p className="text-xs text-neutral-500">
          Your passkey is stored locally for a week and sent as a header on API calls.
        </p>
      </div>
    </div>
  );
}
