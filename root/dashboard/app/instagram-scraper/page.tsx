'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function InstagramDownloaderPage() {
  const [inputText, setInputText] = useState('');
  const [extractedUrls, setExtractedUrls] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<Record<string, { status: string; progress: number }>>({});
  const [error, setError] = useState('');
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [showDebug, setShowDebug] = useState(false);
  
  // Transcription aggregation states
  const [transcriptionPath, setTranscriptionPath] = useState('');
  const [aggregationStatus, setAggregationStatus] = useState('');
  const [aggregatingTranscriptions, setAggregatingTranscriptions] = useState(false);

  // Scraping states
  const [username, setUsername] = useState('');
  const [scrapedReels, setScrapedReels] = useState<any[]>([]);
  const [scraping, setScraping] = useState(false);
  const [scrapeStatus, setScrapeStatus] = useState('');

  // Extract Instagram reel URLs from text
  const extractUrls = () => {
    // Regex to match Instagram reel URLs with or without username
    // Matches: https://www.instagram.com/username/reel/ID/ or https://www.instagram.com/reel/ID/
    const instagramReelRegex = /https?:\/\/(?:www\.)?instagram\.com\/(?:[a-zA-Z0-9_.]+\/)?reel\/([a-zA-Z0-9_-]+)\/?/gi;
    const urls: string[] = [];
    let match;

    // Find all matches and extract unique URLs
    while ((match = instagramReelRegex.exec(inputText)) !== null) {
      const fullUrl = match[0];
      // Normalize the URL (remove trailing slash if present, then add it)
      const normalized = fullUrl.replace(/\/$/, '') + '/';
      if (!urls.includes(normalized)) {
        urls.push(normalized);
      }
    }

    setExtractedUrls(urls);
    setError('');

    if (urls.length === 0) {
      setError('No Instagram reel URLs found in the text. Looking for: https://www.instagram.com/[username]/reel/[ID]');
    }
  };

  // Download videos
  const handleDownload = async () => {
    if (extractedUrls.length === 0) {
      setError('No URLs to download');
      return;
    }

    setLoading(true);
    setError('');
    setDownloadStatus({});
    const startTime = Date.now();

    try {
      setDebugInfo({
        status: 'Starting downloads...',
        urls: extractedUrls,
        startTime: new Date().toISOString(),
      });

      // Download each video
      for (const url of extractedUrls) {
        setDownloadStatus((prev) => ({
          ...prev,
          [url]: { status: 'downloading', progress: 0 },
        }));

        try {
          const response = await fetch('/api/download-instagram-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Download failed');
          }

          const blob = await response.blob();
          const downloadUrl = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = `instagram-reel-${Date.now()}.mp4`;
          a.click();
          window.URL.revokeObjectURL(downloadUrl);

          setDownloadStatus((prev) => ({
            ...prev,
            [url]: { status: 'completed', progress: 100 },
          }));
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          setDownloadStatus((prev) => ({
            ...prev,
            [url]: { status: `error: ${errorMessage}`, progress: 0 },
          }));
        }
      }

      const responseTime = Date.now() - startTime;
      setDebugInfo({
        status: 'All downloads completed',
        urls: extractedUrls,
        responseTime: `${responseTime}ms`,
        downloadStatus,
        timestamp: new Date().toISOString(),
      });
      setShowDebug(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
      setDebugInfo({
        status: 'Error',
        error: errorMessage,
        urls: extractedUrls,
        timestamp: new Date().toISOString(),
      });
      setShowDebug(true);
    } finally {
      setLoading(false);
    }
  };

  // Aggregate transcriptions
  const handleAggregateTranscriptions = async () => {
    if (!transcriptionPath.trim()) {
      setAggregationStatus('Please provide a folder path');
      return;
    }

    setAggregatingTranscriptions(true);
    setAggregationStatus('Processing transcriptions...');

    try {
      const response = await fetch('/api/aggregate-transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: transcriptionPath }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to aggregate transcriptions');
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `aggregated-transcriptions-${Date.now()}.txt`;
      a.click();
      window.URL.revokeObjectURL(downloadUrl);

      setAggregationStatus('✓ Transcriptions aggregated successfully!');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setAggregationStatus(`Error: ${errorMessage}`);
    } finally {
      setAggregatingTranscriptions(false);
    }
  };

  // Scrape Instagram reels
  const handleScrapeReels = async () => {
    if (!username.trim()) {
      setScrapeStatus('Please enter an Instagram username');
      return;
    }

    setScraping(true);
    setScrapeStatus('Scraping reels...');
    setScrapedReels([]);

    try {
      const response = await fetch('/api/scrape-instagram-reels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), maxReels: 10 }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Check if it's the Playwright installation error
        if (data.solution) {
          throw new Error(`${data.error}\n\n💡 Solution: ${data.solution}`);
        }
        throw new Error(data.error || 'Failed to scrape reels');
      }

      setScrapedReels(data.topReels);
      setScrapeStatus(`✓ Found ${data.topReels.length} reels! (${data.totalFound} total scanned)`);
      
      // Auto-populate URLs in the download section
      const urls = data.topReels.map((reel: any) => reel.url);
      setExtractedUrls(urls);
      setError('');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setScrapeStatus(`Error: ${errorMessage}`);
    } finally {
      setScraping(false);
    }
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-purple-900 via-purple-800 to-pink-600 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold text-white mb-2">Instagram Reel Downloader</h1>
        <p className="text-white/70 mb-8">Scrape top reels or paste URLs to download videos</p>

        {/* Scraping Section */}
        <Card className="bg-white/10 backdrop-blur-md border-white/20 p-6 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">🔍 NOT OWRKING - Auto-Scrape Top Reels</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-white mb-2 font-semibold">
                Instagram Username
              </label>
              <input
                type="text"
                placeholder="e.g., rasool1mirzaei"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-black/20 border border-white/20 rounded p-3 text-white placeholder-white/40 focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500"
              />
              <p className="text-white/50 text-xs mt-2">
                Scrapes top 10 most viewed reels from public profiles
              </p>
            </div>

            {scrapeStatus && (
              <div className={`px-4 py-2 rounded ${
                scrapeStatus.startsWith('✓')
                  ? 'bg-green-500/20 border border-green-500 text-green-200'
                  : scrapeStatus.startsWith('Error')
                  ? 'bg-red-500/20 border border-red-500 text-red-200'
                  : 'bg-blue-500/20 border border-blue-500 text-blue-200'
              }`}>
                {scrapeStatus}
              </div>
            )}

            <Button
              onClick={handleScrapeReels}
              disabled={scraping || !username.trim()}
              className="w-full bg-gradient-to-r from-purple-500 to-blue-600 hover:from-purple-600 hover:to-blue-700 text-white font-bold py-2"
            >
              {scraping ? 'Scraping...' : 'Scrape Top Reels'}
            </Button>

            {/* Scraped Results */}
            {scrapedReels.length > 0 && (
              <div className="bg-black/20 border border-white/10 rounded p-4 max-h-64 overflow-y-auto">
                <h3 className="text-white font-semibold mb-3">Top 10 Reels by Views:</h3>
                <div className="space-y-2">
                  {scrapedReels.map((reel, index) => (
                    <div key={reel.id} className="text-sm text-white/80 border-b border-white/10 pb-2">
                      <div className="flex justify-between items-start">
                        <span className="font-mono text-pink-300">#{index + 1}</span>
                        <div className="flex gap-4 text-xs">
                          <span>👁️ {reel.views.toLocaleString()}</span>
                          <span>❤️ {reel.likes.toLocaleString()}</span>
                          <span>💬 {reel.comments}</span>
                        </div>
                      </div>
                      <a href={reel.url} target="_blank" rel="noopener noreferrer" 
                         className="text-blue-300 hover:underline text-xs truncate block mt-1">
                        {reel.url}
                      </a>
                      {reel.caption && (
                        <p className="text-white/60 text-xs mt-1 line-clamp-2">{reel.caption}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Input Section */}
        <Card className="bg-white/10 backdrop-blur-md border-white/20 p-6 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">📋 Reels downloader: Paste Reel URLs</h2>
          <p className="text-white/70 text-sm mb-4">
            Use Perplexity Comet or AI browser to extract top reels from Instagram.html → paste table URLs here
          </p>
          <div className="space-y-4">
            <div>
              <label className="block text-white mb-2 font-semibold">
                Paste text containing Instagram reel URLs
              </label>
              <textarea
                placeholder="e.g., https://www.instagram.com/reel/DTJgTR-gTcV/ or paste text with multiple URLs..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                className="w-full h-32 bg-black/20 border border-white/20 rounded p-3 text-white placeholder-white/40 focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500"
              />
            </div>

            {error && (
              <div className="bg-red-500/20 border border-red-500 text-red-200 px-4 py-2 rounded">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <Button
                onClick={extractUrls}
                className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-bold py-2"
              >
                Extract URLs
              </Button>
              <Button
                onClick={handleDownload}
                disabled={loading || extractedUrls.length === 0}
                className="flex-1 bg-linear-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white font-bold py-2"
              >
                {loading ? 'Downloading...' : 'Download Videos'}
              </Button>
            </div>

            {/* Debug Toggle */}
            {debugInfo && (
              <button
                onClick={() => setShowDebug(!showDebug)}
                className="text-xs text-white/60 hover:text-white/80 underline"
              >
                {showDebug ? '▼' : '▶'} Debug Info
              </button>
            )}

            {/* Debug Panel */}
            {showDebug && debugInfo && (
              <div className="bg-black/30 border border-white/10 rounded p-4 text-white/70 text-xs font-mono space-y-2 max-h-96 overflow-auto">
                <div className="text-yellow-300 font-semibold">
                  Status: {debugInfo.status}
                </div>
                {debugInfo.responseTime && (
                  <div className="text-blue-300">
                    Time: {debugInfo.responseTime}
                  </div>
                )}
                <div className="text-white/50 mt-2 border-t border-white/10 pt-2">
                  <details>
                    <summary className="cursor-pointer hover:text-white/80">URLs ({debugInfo.urls?.length})</summary>
                    <pre className="mt-1 bg-black/50 p-2 rounded overflow-auto">
                      {debugInfo.urls?.map((url: string) => `• ${url}`).join('\n')}
                    </pre>
                  </details>
                </div>
                {debugInfo.downloadStatus && (
                  <div className="text-white/50 border-t border-white/10 pt-2">
                    <details>
                      <summary className="cursor-pointer hover:text-white/80">Download Status</summary>
                      <pre className="mt-1 bg-black/50 p-2 rounded overflow-auto">
                        {JSON.stringify(debugInfo.downloadStatus, null, 2)}
                      </pre>
                    </details>
                  </div>
                )}
                {debugInfo.error && (
                  <div className="text-red-400 border-t border-white/10 pt-2">
                    <details open>
                      <summary className="cursor-pointer hover:text-red-300">Error</summary>
                      <pre className="mt-1 bg-black/50 p-2 rounded">
                        {debugInfo.error}
                      </pre>
                    </details>
                  </div>
                )}
                <div className="text-white/40 text-xs border-t border-white/10 pt-2">
                  {debugInfo.timestamp}
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Extracted URLs Section */}
        {extractedUrls.length > 0 && (
          <Card className="bg-white/10 backdrop-blur-md border-white/20 p-6 mb-8">
            <h2 className="text-xl font-bold text-white mb-4">
              Found {extractedUrls.length} reel{extractedUrls.length !== 1 ? 's' : ''}
            </h2>
            <div className="space-y-2">
              {extractedUrls.map((url) => (
                <div
                  key={url}
                  className="bg-black/20 border border-white/10 rounded p-3 flex items-center justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm truncate">{url}</p>
                    {downloadStatus[url] && (
                      <p className={`text-xs mt-1 ${
                        downloadStatus[url].status === 'completed'
                          ? 'text-green-400'
                          : downloadStatus[url].status === 'downloading'
                          ? 'text-blue-400'
                          : 'text-red-400'
                      }`}>
                        {downloadStatus[url].status}
                      </p>
                    )}
                  </div>
                  {downloadStatus[url] && downloadStatus[url].progress > 0 && (
                    <div className="w-16 h-2 bg-black/30 rounded ml-4">
                      <div
                        className="h-full bg-pink-500 rounded transition-all"
                        style={{ width: `${downloadStatus[url].progress}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Transcription Aggregation Section */}
        <Card className="bg-white/10 backdrop-blur-md border-white/20 p-6 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">Aggregate Transcriptions</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-white mb-2 font-semibold">
                Transcription Files Folder Path
              </label>
              <input
                type="text"
                placeholder="e.g., C:\Downloads\transcriptions or path with .txt files"
                value={transcriptionPath}
                onChange={(e) => setTranscriptionPath(e.target.value)}
                className="w-full bg-black/20 border border-white/20 rounded p-3 text-white placeholder-white/40 focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500"
              />
              <p className="text-white/50 text-xs mt-2">
                Path to folder containing transcription files (e.g., instagram-reel-17868991110836 (transcribed on...).txt)
              </p>
            </div>

            {aggregationStatus && (
              <div className={`px-4 py-2 rounded ${
                aggregationStatus.startsWith('✓')
                  ? 'bg-green-500/20 border border-green-500 text-green-200'
                  : aggregationStatus.startsWith('Error')
                  ? 'bg-red-500/20 border border-red-500 text-red-200'
                  : 'bg-blue-500/20 border border-blue-500 text-blue-200'
              }`}>
                {aggregationStatus}
              </div>
            )}

            <Button
              onClick={handleAggregateTranscriptions}
              disabled={aggregatingTranscriptions || !transcriptionPath.trim()}
              className="w-full bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 text-white font-bold py-2"
            >
              {aggregatingTranscriptions ? 'Aggregating...' : 'Aggregate Transcriptions'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
