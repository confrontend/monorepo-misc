"use client";

import { useState } from "react";
import Link from "next/link";

export default function YoutubeSubtitlesPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (!url.trim()) {
      setError("Please enter a YouTube URL");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/youtube-subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistUrl: url }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to download subtitles");
      }

      setResult(data.output);
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-sm text-gray-600 hover:text-black">
          ← Back to Dashboard
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">YouTube Subtitles Downloader</h1>
      
      <p className="text-sm text-gray-600">
        Download subtitles from YouTube videos or playlists as plain text files.
      </p>

      <div className="space-y-3">
        <label className="block text-sm font-medium">
          YouTube Video or Playlist URL
        </label>
        <input
          type="text"
          className="w-full border rounded p-3"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=... or playlist URL"
          disabled={loading}
        />
        
        <button
          onClick={handleDownload}
          disabled={loading || !url.trim()}
          className="rounded px-6 py-3 bg-blue-600 text-white font-medium shadow hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Downloading..." : "Download Subtitles"}
        </button>
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 text-red-700 rounded p-4 text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="border border-green-300 bg-green-50 rounded p-4 space-y-2">
          <h3 className="font-semibold text-green-800">Success!</h3>
          <pre className="text-xs text-green-700 whitespace-pre-wrap overflow-auto max-h-96">
            {result}
          </pre>
          <p className="text-xs text-green-600">
           <code> Subtitles saved to the output</code> folder in your project.
          </p>
        </div>
      )}

      <div className="border-t pt-4 mt-6">
        <h3 className="font-medium mb-2">How it works:</h3>
        <ul className="text-sm text-gray-600 space-y-1 list-disc list-inside">
          <li>Paste a YouTube video or playlist URL</li>
          <li>Click "Download Subtitles"</li>
          <li>Subtitles will be saved as .txt files in the output folder</li>
          <li>Supports both manual and auto-generated subtitles</li>
        </ul>
      </div>
    </main>
  );
}
