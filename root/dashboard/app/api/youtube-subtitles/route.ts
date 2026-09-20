import { NextRequest, NextResponse } from "next/server";

// Force dynamic prevents caching of streaming responses
export const dynamic = 'force-dynamic';

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://localhost:8000";

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") || "";
    let payload: { url?: string; html?: string; max_downloads?: number };

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file");

      if (!file || typeof file === "string" || typeof file.text !== "function") {
        return NextResponse.json(
          { error: "An HTML file is required" },
          { status: 400 },
        );
      }

      payload = { html: await file.text() };
    } else {
      const body = await req.json();
      const videoUrl = body.videoUrl || body.url;

      if (!videoUrl) {
        return NextResponse.json(
          { error: "Video URL or HTML file is required" },
          { status: 400 },
        );
      }

      payload = {
        url: videoUrl,
        max_downloads: body.maxDownloads,
      };
    }

    // 1. Call Python Backend
    const pythonRes = await fetch(`${PYTHON_API_URL}/api/youtube-subtitles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Important: prevent Node from buffering the response
      // @ts-expect-error Node fetch supports duplex, but lib.dom RequestInit does not declare it.
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

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    console.error("API Route Error:", error);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
