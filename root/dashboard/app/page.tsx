"use client";

import AppCard from "@/components/AppCard";
import { logoutPasskey } from "@/lib/authedFetch";

const apps = [
  {
    name: "Reddit Fetcher",
    description: "Fetch and display Reddit posts",
    href: "/reddit-fetcher",
  },
  {
    name: "YouTube Subtitles",
    description: "Download YouTube subtitles",
    href: "/youtube-subtitles",
  },
  {
    name: "Site Extractor",
    description: "Extract main text from multiple URLs",
    href: "/site-extractor",
  },
];

export default function HomePage() {
  return (
    <main className="container mx-auto p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">My App Dashboard</h1>
        <button
          onClick={logoutPasskey}
          className="text-sm text-gray-600 underline hover:text-black"
        >
          Logout
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {apps.map((app) => (
          <AppCard key={app.name} {...app} />
        ))}
      </div>
    </main>
  );
}
