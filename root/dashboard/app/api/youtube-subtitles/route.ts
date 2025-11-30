import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  try {
    const { playlistUrl } = await req.json();

    if (!playlistUrl) {
      return NextResponse.json(
        { error: "Playlist URL is required" },
        { status: 400 }
      );
    }

    // Path to your Python script
    const scriptPath = path.join(process.cwd(), "scripts", "youtube_subtitles.py");
    
    // Use 'python' instead of 'python3' on Windows
    const pythonCommand = process.platform === "win32" ? "python" : "python3";
    
    // Run the Python script with the URL as argument
    const { stdout, stderr } = await execAsync(
      `${pythonCommand} "${scriptPath}" "${playlistUrl}"`,
      { cwd: process.cwd() }
    );

    return NextResponse.json({
      success: true,
      output: stdout,
      message: "Subtitles downloaded successfully",
    });
  } catch (error: any) {
    console.error("Error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to download subtitles" },
      { status: 500 }
    );
  }
}
