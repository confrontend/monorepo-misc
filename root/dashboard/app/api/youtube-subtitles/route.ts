import { NextRequest, NextResponse } from "next/server";

const PYTHON_API_URL = process.env.PYTHON_API_URL || "https://reliable-strength-production.up.railway.app";

export async function POST(req: NextRequest) {
  console.log("=== YouTube Subtitles API Called ===");
  
  try {
    // Debug: Log raw request
    console.log("Request URL:", req.url);
    console.log("Request method:", req.method);
    console.log("Python API URL:", PYTHON_API_URL);

    // Parse body
    const body = await req.json();
    console.log("Received body:", JSON.stringify(body, null, 2));

    const videoUrl = body.videoUrl || body.url;
    console.log("Extracted video URL:", videoUrl);

    if (!videoUrl) {
      console.error("ERROR: No video URL provided");
      return NextResponse.json(
        { 
          error: "Video URL is required", 
          receivedBody: body,
          debug: "videoUrl field is missing"
        },
        { status: 400 }
      );
    }

    // Prepare request to Python API
    const pythonApiUrl = `${PYTHON_API_URL}/api/youtube-subtitles`;
    const requestBody = { url: videoUrl };
    
    console.log("Calling Python API at:", pythonApiUrl);
    console.log("Sending body:", JSON.stringify(requestBody, null, 2));

    // Call Python API
    const response = await fetch(pythonApiUrl, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    console.log("Python API response status:", response.status);
    console.log("Python API response headers:", Object.fromEntries(response.headers));

    // Parse response
    const data = await response.json();
    console.log("Python API response data:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      console.error("Python API returned error:", data);
      throw new Error(data.detail || data.error || "Failed to fetch subtitles");
    }

    console.log("SUCCESS: Subtitles fetched successfully");
    return NextResponse.json(data);

  } catch (error: any) {
    console.error("=== ERROR in YouTube Subtitles API ===");
    console.error("Error type:", error.constructor.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
    
    return NextResponse.json(
      { 
        error: error.message || "Failed to fetch subtitles",
        errorType: error.constructor.name,
        debug: {
          pythonApiUrl: PYTHON_API_URL,
          timestamp: new Date().toISOString()
        }
      },
      { status: 500 }
    );
  }
}
