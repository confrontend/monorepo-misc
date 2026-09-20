"use client";

import { useState } from "react";
import Link from "next/link";

type StreamEvent = {
  type:
    | "discovery"
    | "playlist_found"
    | "playlist_start"
    | "playlist_complete"
    | "playlist_error"
    | "progress"
    | "partial_result"
    | "complete"
    | "error";
  message?: string;
  phase?: string;
  current?: number;
  total?: number;
  overall_current?: number;
  overall_total?: number;
  playlist_index?: number;
  playlist_total?: number;
  playlist_title?: string;
  playlist_url?: string;
  video_index?: number;
  video_total?: number;
  title?: string;
  text?: string;
  video_count?: number;
  playlist_count?: number;
  successful_video_count?: number;
  saved_file?: string;
  output_directory?: string;
  aggregate_file?: string;
  status?: string;
};

type ProgressState = {
  message: string;
  overallPct: number;
  playlistPct: number;
  overallCurrent: number;
  overallTotal: number;
  playlistCurrent: number;
  playlistTotal: number;
};

type PlaylistProgress = {
  index: number;
  title: string;
  url: string;
  videoTotal: number;
  status: string;
  message: string;
};

type ResultState = {
  title: string;
  text: string;
  count: number;
  playlistCount: number;
  successfulCount: number;
  outputDirectory: string;
  aggregateFile: string;
};

function percentage(current: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)));
}

export default function YoutubeSubtitles() {
  const [url, setUrl] = useState("");
  const [htmlFile, setHtmlFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistProgress[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveVideoCount, setLiveVideoCount] = useState(0);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [result, setResult] = useState<ResultState | null>(null);
  const [error, setError] = useState("");
  const [abortController, setAbortController] =
    useState<AbortController | null>(null);

  const upsertPlaylist = (data: StreamEvent) => {
    if (!data.playlist_index) return;

    setPlaylists((current) => {
      const next: PlaylistProgress = {
        index: data.playlist_index!,
        title: data.playlist_title || `Playlist ${data.playlist_index}`,
        url: data.playlist_url || "",
        videoTotal: data.video_total || 0,
        status: data.status || "ready",
        message: data.message || "",
      };
      const existingIndex = current.findIndex(
        (playlist) => playlist.index === next.index,
      );

      if (existingIndex === -1) return [...current, next];

      const updated = [...current];
      updated[existingIndex] = { ...updated[existingIndex], ...next };
      return updated;
    });
  };

  const handleEvent = (data: StreamEvent) => {
    if (data.type === "error") {
      throw new Error(data.message || "An error occurred");
    }

    if (
      data.type === "playlist_found" ||
      data.type === "playlist_start" ||
      data.type === "playlist_complete" ||
      data.type === "playlist_error"
    ) {
      upsertPlaylist(data);
    }

    if (data.type === "discovery" || data.type === "progress") {
      const overallCurrent = data.overall_current ?? data.current ?? 0;
      const overallTotal = data.overall_total ?? data.total ?? 1;
      const playlistCurrent = data.video_index ?? data.current ?? 0;
      const playlistTotal = data.video_total ?? data.total ?? 1;

      setProgress({
        message: data.message || "Processing...",
        overallPct: percentage(overallCurrent, overallTotal),
        playlistPct: percentage(playlistCurrent, playlistTotal),
        overallCurrent,
        overallTotal,
        playlistCurrent,
        playlistTotal,
      });
    }

    if (data.type === "partial_result") {
      setLiveText((current) =>
        current ? `${current}\n${data.text || ""}` : data.text || "",
      );
      setLiveVideoCount(data.video_count || 0);
      if (data.output_directory) setOutputDirectory(data.output_directory);
    }

    if (data.type === "complete") {
      setLiveText(data.text || "");
      setLiveVideoCount(data.video_count || 0);
      if (data.output_directory) setOutputDirectory(data.output_directory);
      setResult({
        title: data.title || "YouTube subtitles",
        text: data.text || "",
        count: data.video_count || 0,
        playlistCount: data.playlist_count || 0,
        successfulCount: data.successful_video_count || 0,
        outputDirectory: data.output_directory || "",
        aggregateFile: data.aggregate_file || "",
      });
      setProgress(null);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!htmlFile && !url.trim()) {
      setError("Enter a YouTube URL or choose a saved YouTube HTML file.");
      return;
    }

    const controller = new AbortController();
    setAbortController(controller);
    setLoading(true);
    setError("");
    setResult(null);
    setPlaylists([]);
    setLiveText("");
    setLiveVideoCount(0);
    setOutputDirectory("");
    setProgress({
      message: htmlFile ? "Reading HTML file..." : "Connecting...",
      overallPct: 0,
      playlistPct: 0,
      overallCurrent: 0,
      overallTotal: 1,
      playlistCurrent: 0,
      playlistTotal: 1,
    });

    try {
      let body: BodyInit;
      const headers: HeadersInit = {};

      if (htmlFile) {
        const formData = new FormData();
        formData.append("file", htmlFile);
        body = formData;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({ videoUrl: url.trim() });
      }

      const response = await fetch("/api/youtube-subtitles", {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(await response.text());
      if (!response.body) throw new Error("No response body received");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        handleEvent(JSON.parse(line) as StreamEvent);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.forEach(consumeLine);
      }

      buffer += decoder.decode();
      consumeLine(buffer);
    } catch (caughtError) {
      const errorValue = caughtError as Error;
      if (errorValue.name !== "AbortError") {
        setError(errorValue.message || "An error occurred");
      }
    } finally {
      setLoading(false);
      setProgress(null);
      setAbortController(null);
    }
  };

  const handleCancel = () => {
    abortController?.abort();
  };

  const downloadText = (text: string, filename: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
  };

  const downloadResult = () => {
    if (result) downloadText(result.text, "youtube-subtitles.txt");
  };

  const downloadLiveResult = () => {
    if (liveText) downloadText(liveText, "youtube-subtitles-partial.txt");
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link
        href="/"
        className="mb-6 inline-block text-blue-400 transition-colors hover:text-blue-300"
      >
        &larr; Back to Dashboard
      </Link>

      <h1 className="mb-2 text-2xl font-bold text-white">
        YouTube Subtitle Downloader
      </h1>
      <p className="mb-6 text-gray-400">
        Process a video, playlist URL, or a saved YouTube playlists HTML page.
      </p>

      <form onSubmit={handleSubmit} className="mb-6 space-y-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-300">
            YouTube URL
          </label>
          <input
            type="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (event.target.value) setHtmlFile(null);
            }}
            placeholder="https://www.youtube.com/playlist?list=..."
            className="w-full rounded border border-gray-700 bg-gray-900 p-3 text-white outline-none focus:ring-2 focus:ring-blue-500"
            disabled={Boolean(htmlFile)}
          />
        </div>

        <div className="text-center text-sm text-gray-500">or</div>

        <div className="rounded border border-dashed border-gray-600 bg-gray-900/60 p-4">
          <label className="mb-2 block text-sm font-medium text-gray-300">
            YouTube HTML file
          </label>
          <input
            type="file"
            accept=".html,.htm,text/html"
            onChange={(event) => {
              const selectedFile = event.target.files?.[0] || null;
              setHtmlFile(selectedFile);
              if (selectedFile) setUrl("");
            }}
            className="block w-full text-sm text-gray-300 file:mr-4 file:rounded file:border-0 file:bg-blue-600 file:px-4 file:py-2 file:text-white hover:file:bg-blue-700"
            disabled={Boolean(url.trim())}
          />
          {htmlFile && (
            <p className="mt-2 text-sm text-green-400">
              Selected: {htmlFile.name} ({Math.round(htmlFile.size / 1024)} KB)
            </p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            Use a saved YouTube channel playlists page, such as the supplied
            Inner Circle Trader HTML file.
          </p>
        </div>

        <button
          disabled={loading || (!htmlFile && !url.trim())}
          className="w-full rounded bg-blue-600 p-3 font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-600"
        >
          {loading
            ? "Processing..."
            : htmlFile
              ? "Find Playlists & Download Subtitles"
              : "Get Subtitles"}
        </button>
      </form>

      {progress && (
        <div className="mb-6 rounded border border-gray-700 bg-gray-800 p-4">
          <div className="mb-2 flex justify-between gap-4 text-blue-300">
            <span className="truncate">{progress.message}</span>
            <span className="shrink-0 font-medium">
              {progress.overallPct}%
            </span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded bg-gray-700">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress.overallPct}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-400">
            <span>
              Overall: {progress.overallCurrent}/{progress.overallTotal}
            </span>
            <span>
              Current playlist: {progress.playlistPct}% (
              {progress.playlistCurrent}/{progress.playlistTotal})
            </span>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="mt-4 rounded bg-red-600 px-3 py-1 text-sm text-white transition-colors hover:bg-red-700"
          >
            Cancel
          </button>
        </div>
      )}

      {playlists.length > 0 && (
        <div className="mb-6 rounded border border-gray-700 bg-gray-900 p-4">
          <h2 className="mb-3 text-lg font-semibold text-white">
            Playlists ({playlists.length})
          </h2>
          <div className="max-h-72 space-y-2 overflow-auto">
            {playlists.map((playlist) => (
              <div
                key={`${playlist.index}-${playlist.url}`}
                className="rounded border border-gray-800 bg-gray-950 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-200">
                      {playlist.index}. {playlist.title}
                    </p>
                    <p className="text-xs text-gray-500">
                      {playlist.videoTotal} video(s)
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-xs font-medium ${
                      playlist.status === "complete"
                        ? "text-green-400"
                        : playlist.status === "error"
                          ? "text-red-400"
                          : playlist.status === "processing"
                            ? "text-blue-400"
                            : "text-gray-400"
                    }`}
                  >
                    {playlist.status}
                  </span>
                </div>
                {playlist.message && (
                  <p className="mt-1 truncate text-xs text-gray-500">
                    {playlist.message}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded border border-red-800 bg-red-900/50 p-4 text-red-200">
          Error: {error}
        </div>
      )}

      {liveText && !result && (
        <div className="mb-6 rounded-lg border border-blue-800 bg-gray-900 p-4 text-white shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">Live subtitle results</h2>
              <p className="mt-1 text-sm text-gray-400">
                {liveVideoCount} video(s) completed so far. New results appear
                after each video.
              </p>
              {outputDirectory && (
                <p className="mt-1 break-all text-xs text-green-400">
                  Saved under: {outputDirectory}
                </p>
              )}
            </div>
            <button
              onClick={downloadLiveResult}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700"
            >
              Download current .txt
            </button>
          </div>
          <div className="h-80 overflow-auto rounded border border-gray-700 bg-gray-950 p-4">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-200">
              {liveText}
            </pre>
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-gray-900 shadow-sm">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">{result.title}</h2>
              <p className="mt-1 text-sm text-gray-500">
                {result.successfulCount}/{result.count} videos returned usable
                subtitles across {result.playlistCount} playlist(s).
              </p>
              <p className="mt-1 break-all text-xs text-green-700">
                Saved under: {result.outputDirectory}
              </p>
              <p className="break-all text-xs text-gray-500">
                Aggregate: {result.aggregateFile}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={downloadResult}
                className="rounded bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700"
              >
                Download .txt
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(result.text)}
                className="rounded bg-gray-800 px-4 py-2 text-sm text-white transition-colors hover:bg-black"
              >
                Copy
              </button>
            </div>
          </div>

          <div className="h-96 overflow-auto rounded border border-gray-200 bg-gray-50 p-4">
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-900">
              {result.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
