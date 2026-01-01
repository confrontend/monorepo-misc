import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { urls } = await req.json();
    
    const results = await Promise.all(urls.map(async (url: string) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const html = await res.text();
        
        // Simple regex to grab text from common tags (strips scripts/styles)
        // For a production app, use a library like 'cheerio' or 'jsdom'
        const cleanText = html
          .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gmi, "")
          .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gmi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        return { url, text: cleanText, success: true };
      } catch (err: any) {
        return { url, error: err.message, success: false };
      }
    }));

    return NextResponse.json({ results });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}