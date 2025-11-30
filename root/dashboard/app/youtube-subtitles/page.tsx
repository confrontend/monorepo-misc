'use client';

import { useState } from 'react';
import Link from 'next/link';

// Define the shape of the incoming stream data
type StreamEvent = {
  type: 'progress' | 'complete' | 'error';
  message: string;
  current?: number;
  total?: number;
  title?: string;
  text?: string;
  video_count?: number;
  success?: boolean;
};

export default function YoutubeSubtitles() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ msg: string; pct: number } | null>(null);
  const [result, setResult] = useState<{ title: string; text: string; count: number } | null>(null);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    setProgress({ msg: 'Connecting...', pct: 0 });

    try {
      const response = await fetch('/api/youtube-subtitles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: url }),
      });

      if (!response.ok) throw new Error(await response.text());
      if (!response.body) throw new Error("No response body received");

      // --- STREAM READER LOGIC ---
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data: StreamEvent = JSON.parse(line);

            if (data.type === 'progress') {
              const pct = data.total ? Math.round((data.current! / data.total) * 100) : 0;
              setProgress({ msg: data.message, pct });
            } 
            else if (data.type === 'complete') {
              setResult({
                title: data.title || 'Unknown',
                text: data.text || '',
                count: data.video_count || 1
              });
              setLoading(false);
              setProgress(null);
            } 
            else if (data.type === 'error') {
              throw new Error(data.message);
            }
          } catch (e) {
            console.warn("Error parsing stream chunk", e);
          }
        }
      }

    } catch (err: any) {
      setError(err.message || 'An error occurred');
      setLoading(false);
      setProgress(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      {/* --- ADDED BACK BUTTON --- */}
      <Link href="/" className="text-blue-400 hover:text-blue-300 mb-6 inline-block transition-colors">
        ← Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold mb-4 text-white">YouTube Subtitle Downloader</h1>
      
      <form onSubmit={handleSubmit} className="mb-6 gap-2 flex flex-col">
        <input 
          type="text" 
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Enter YouTube Playlist or Video URL..."
          className="border border-gray-700 bg-gray-900 text-white p-3 rounded focus:ring-2 focus:ring-blue-500 outline-none"
          required
        />
        <button 
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 text-white p-3 rounded disabled:bg-gray-600 disabled:cursor-not-allowed font-bold transition-colors"
        >
          {loading ? 'Processing...' : 'Get Subtitles'}
        </button>
      </form>

      {/* Progress Bar */}
      {progress && (
        <div className="mb-6 bg-gray-800 border border-gray-700 p-4 rounded">
          <div className="flex justify-between text-blue-300 font-medium mb-2">
            <span>{progress.msg}</span>
            <span>{progress.pct}%</span>
          </div>
          <div className="w-full bg-gray-700 h-2 rounded overflow-hidden">
            <div 
              className="bg-blue-500 h-full transition-all duration-300" 
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="text-red-200 bg-red-900/50 border border-red-800 p-4 rounded mb-4">
          ❌ {error}
        </div>
      )}

      {result && (
        <div className="border border-gray-200 rounded-lg p-6 shadow-sm bg-white text-gray-900">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h2 className="text-xl font-bold text-gray-900">{result.title}</h2>
              <p className="text-gray-500 text-sm mt-1">
                Extracted from {result.count} video{result.count !== 1 ? 's' : ''}
              </p>
            </div>
            <button 
              onClick={() => {
                navigator.clipboard.writeText(result.text);
                alert("Copied to clipboard!");
              }}
              className="bg-gray-800 hover:bg-black text-white px-4 py-2 rounded text-sm transition-colors"
            >
              Copy to Clipboard
            </button>
          </div>

          {/* --- FIXED TEXT VISIBILITY --- */}
          <div className="bg-gray-50 border border-gray-200 p-4 rounded h-96 overflow-auto">
            <pre className="text-gray-900 whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {result.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}