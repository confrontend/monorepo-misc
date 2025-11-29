import Link from "next/link";

export default function AppCard({ name, description, href }: { name: string, description: string, href: string }) {
  return (
    <Link href={href} className="block border rounded-lg p-4 shadow hover:shadow-lg transition">
      <h2 className="font-bold text-xl mb-2">{name}</h2>
      <p className="text-gray-700">{description}</p>
    </Link>
  );
}
