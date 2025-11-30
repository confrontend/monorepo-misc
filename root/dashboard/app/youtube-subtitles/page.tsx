"use client";

import { useState } from "react";
import Link from "next/link";

interface VideoResult {
  title: string;
  text: string | null;
  url: string;
  error?: string;
  word_count?: number;
}

interface ApiResponse {
  success: boolean;
  type: "video" | "playlist";
  title?: string;
  text?: string;
  playlist_title?: string;
  video_count?: number;
  videos?: VideoResult[];
  combined_text?: string;
  total_words?: number;
  word_count?: number;
  message: string;
}

export default function YoutubeSubtitlesPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (!url.trim()) {
      setError("Please enter a YouTube URL");
      return;
    }

    console.log("Processing URL:", url);

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/youtube-subtitles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl: url }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch subtitles");
      }

      setResult(data);
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  function downloadAsFile() {
    if (!result) return;
    
    const text = result.type === "playlist" 
      ? result.combined_text 
      : result.text;
      
    const filename = result.type === "playlist"
      ? `${result.playlist_title || 'playlist'}-subtitles.txt`
      : `${result.title || 'video'}-subtitles.txt`;
    
    const blob = new Blob([text || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-4">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-sm text-gray-600 hover:text-black">
          ← Back to Dashboard
        </Link>
      </div>

      <h1 className="text-2xl font-semibold">YouTube Subtitles Downloader</h1>
      
      <p className="text-sm text-gray-600">
        Download subtitles from YouTube videos or entire playlists as plain text.
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
          {loading ? "Processing..." : "Get Subtitles"}
        </button>
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 text-red-700 rounded p-4">
          {error}
        </div>
      )}

      {result && (
        <div className="border border-green-300 bg-green-50 rounded p-4 space-y-3">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-green-800">
                {result.type === "playlist" ? "Playlist Processed!" : "Subtitles Retrieved!"}
              </h3>
              {result.type === "playlist" && (
                <p className="text-sm text-green-700 mt-1">
                  {result.playlist_title} • {result.video_count} videos • {result.total_words?.toLocaleString()} words
                </p>
              )}
              {result.type === "video" && (
                <p className="text-sm text-green-700 mt-1">
                  {result.title} • {result.word_count?.toLocaleString()} words
                </p>
              )}
            </div>
            <button
              onClick={downloadAsFile}
              className="text-sm px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
            >
              Download as .txt
            </button>
          </div>

          {result.type === "playlist" && result.videos && (
            <div className="space-y-2 mt-4">
              <h4 className="font-medium text-green-800">Videos in playlist:</h4>
              <div className="max-h-64 overflow-auto border border-green-200 bg-white rounded p-3">
                {result.videos.map((video, idx) => (
                  <div key={idx} className="py-2 border-b last:border-b-0">
                    <div className="flex items-start gap-2">
                      <span className="text-xs text-gray-500 mt-0.5">{idx + 1}.</span>
                      <div className="flex-1">
                        <div className="text-sm font-medium">{video.title}</div>
                        {video.text ? (
                          <div className="text-xs text-green-600">
                            ✓ {video.word_count?.toLocaleString()} words
                          </div>
                        ) : (
                          <div className="text-xs text-red-600">
                            ✗ {video.error || "No subtitles available"}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border border-green-200 bg-white rounded p-3 max-h-96 overflow-auto">
            <pre className="text-sm text-gray-800 whitespace-pre-wrap">
              {result.type === "playlist" ? result.combined_text : result.text}
            </pre>
          </div>
        </div>
      )}

      <div className="border-t pt-4 mt-6">
        <h3 className="font-medium mb-2">How it works:</h3>
        <ul className="text-sm text-gray-600 space-y-1 list-disc list-inside">
          <li>Paste a YouTube video or playlist URL</li>
          <li>Click "Get Subtitles" to process</li>
          <li>For playlists: processes up to 50 videos automatically</li>
          <li>Download combined transcripts as a text file</li>
          <li>Great for researching content, creating study materials, or analyzing videos</li>
          <li>Supports both manual and auto-generated captions</li>
        </ul>
      </div>
    </main>
  );
}
