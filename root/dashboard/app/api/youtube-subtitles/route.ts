import { NextRequest, NextResponse } from "next/server";

// Force dynamic prevents caching of streaming responses
export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://localhost:8000";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const videoUrl = body.videoUrl || body.url;

    if (!videoUrl) {
      return NextResponse.json({ error: "Video URL is required" }, { status: 400 });
    }

    // 1. Call Python Backend
    const pythonRes = await fetch(`${PYTHON_API_URL}/api/youtube-subtitles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: videoUrl }),
      // Important: prevent Node from buffering the response
      // @ts-ignore - 'duplex' is a valid node-fetch option but ts definition might be outdated
      duplex: 'half' 
    });

    // 2. Handle connection errors
    if (!pythonRes.ok) {
      const errText = await pythonRes.text();
      return NextResponse.json(
        { error: `Python API error: ${errText}` },
        { status: pythonRes.status }
      );
    }

    // 3. CRITICAL: Pass the stream through directly. DO NOT usage .json() here.
    return new Response(pythonRes.body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      },
    });

  } catch (error: any) {
    console.error("API Route Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}