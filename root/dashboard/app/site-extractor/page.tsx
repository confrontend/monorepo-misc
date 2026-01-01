"use client";

import { useState } from "react";
import Link from "next/link";
import { authedFetch } from "@/lib/authedFetch";

export default function SiteExtractor() {
  const [urls, setUrls] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);

  const handleFetch = async () => {
    setLoading(true);
    const urlList = urls.split("\n").map(u => u.trim()).filter(Boolean);
    
    try {
      const res = await authedFetch("/api/site-extractor", {
        method: "POST",
        body: JSON.stringify({ urls: urlList }),
      });
      const data = await res.json();
      setResults(data.results || []);
    } catch (err) {
      alert("Failed to fetch content");
    } finally {
      setLoading(false);
    }
  };

  const allText = results.map(r => `--- ${r.url} ---\n${r.text || r.error}`).join("\n\n");

  return (
    <main className="max-w-4xl mx-auto p-6">
      <Link href="/" className="text-blue-500 mb-4 inline-block">← Back</Link>
      <h1 className="text-2xl font-bold mb-4">Site Text Extractor</h1>
      
      <textarea
        className="w-full border p-2 h-40 rounded mb-4 text-white"
        placeholder="Paste URLs here (one per line)..."
        value={urls}
        onChange={(e) => setUrls(e.target.value)}
      />

      <div className="flex gap-2 mb-6">
        <button
          onClick={handleFetch}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:bg-gray-400"
        >
          {loading ? "Extracting..." : "Extract Text"}
        </button>
        
        <button
          onClick={() => {
            navigator.clipboard.writeText(allText);
            alert("Copied all text to clipboard!");
          }}
          disabled={!results.length}
          className="bg-green-600 text-white px-4 py-2 rounded disabled:bg-gray-400"
        >
          Copy All to Clipboard
        </button>
      </div>

      <div className="space-y-4">
        {results.map((res, i) => (
          <div key={i} className="border p-4 rounded bg-gray-50 text-black">
            <h3 className="font-bold text-sm truncate mb-2">{res.url}</h3>
            <div className="max-h-40 overflow-y-auto text-sm whitespace-pre-wrap">
              {res.success ? res.text : `Error: ${res.error}`}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}