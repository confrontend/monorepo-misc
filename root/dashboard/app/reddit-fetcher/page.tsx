"use client";

import { authedFetch, logoutPasskey } from "@/lib/authedFetch";
import { useState } from "react";

type ApiResponse = {
  ok: boolean;
  results: any[];
  errors: { url: string; error: string }[];
};

export default function Home() {
  const [urls, setUrls] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onFetch() {
    setLoading(true);
    setErr(null);
    setData(null);
    try {
      const cleaned = urls
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await authedFetch("/api/reddit", {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // will be merged
        body: JSON.stringify({ urls: cleaned }),
      });

      const json = (await res.json()) as ApiResponse;
      if (!res.ok) {
        setErr((json as any)?.error ?? "Request failed");
      } else {
        setData(json);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  function downloadJSON() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "reddit-threads.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Reddit Thread → JSON</h1>
      <button
        onClick={logoutPasskey}
        className="text-sm text-gray-600 underline hover:text-black"
      >
        Logout
      </button>
      <label className="block text-sm font-medium">
        Reddit URLs (one per line)
      </label>
      <textarea
        className="w-full border rounded p-2 h-40"
        value={urls}
        onChange={(e) => setUrls(e.target.value)}
        placeholder="https://www.reddit.com/r/.../comments/<id>/..."
      />

      <div className="flex gap-2">
        <button
          onClick={onFetch}
          disabled={loading}
          className="rounded px-4 py-2 border shadow disabled:opacity-50"
        >
          {loading ? "Fetching..." : "Fetch"}
        </button>
        <button
          onClick={downloadJSON}
          disabled={!data}
          className="rounded px-4 py-2 border shadow disabled:opacity-50"
        >
          Download JSON
        </button>
      </div>

      {err && <div className="text-red-600 text-sm">{err}</div>}

      {data && (
        <pre className="whitespace-pre-wrap text-sm border rounded p-3 overflow-auto max-h-[60vh]">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}

      <p className="text-xs text-gray-500">
        Tip: This uses Reddit’s public <code>.json?raw_json=1</code> endpoint
        via a server-side route to avoid CORS. For heavier use, add OAuth and
        caching (see notes below).
      </p>
    </main>
  );
}