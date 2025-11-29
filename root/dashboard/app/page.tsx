import AppCard from "@/components/AppCard";

const apps = [
  { name: "Reddit Fetcher", description: "Fetch and display Reddit posts", href: "/reddit-fetcher" },
  { name: "YouTube Subtitles", description: "Download YouTube subtitles", href: "/youtube-subtitles" },
];

export default function HomePage() {
  return (
    <main className="container mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">My App Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {apps.map(app => (
          <AppCard key={app.name} {...app} />
        ))}
      </div>
    </main>
  );
}
