import { exec } from 'child_process';
import { NextRequest, NextResponse } from 'next/server';
import util from 'util';
import path from 'path';
const execPromise = util.promisify(exec);

export async function POST(request: NextRequest) {
  console.log('🎥 Instagram Downloader');
  
  try {
    const { url } = await request.json();
    console.log('📱 Reel:', url);
    
    const outputPath = path.join(process.platform === 'win32' ? path.join(process.env.TEMP || '/tmp', `reel_${Date.now()}.%(ext)s`) : `/tmp/reel_${Date.now()}.%(ext)s`);
    
    // 🔥 FIXED: Instagram-friendly format + auto-best
    const { stdout, stderr } = await execPromise(
      `yt-dlp --merge-output-format mp4 -f "best[ext=mp4]/best" --no-playlist "${url}" -o "${outputPath}"`,
      { timeout: 60000, maxBuffer: 1024 * 1024 * 20 }
    );
    
    console.log('📤 yt-dlp output:', stdout.slice(-500));
    
    // Find the actual output file (yt-dlp uses .%(ext)s pattern)
    const dir = path.dirname(outputPath);
    const files = await import('fs').then(fs => fs.readdirSync(dir));
    const videoFile = files.find(f => f.includes('reel_') && /\.(mp4|mkv|webm)$/.test(f));
    
    if (!videoFile) {
      throw new Error('No video file found after download');
    }
    
    const fullPath = path.join(dir, videoFile);
    const fs = await import('fs');
    const videoBuffer = fs.readFileSync(fullPath);
    fs.unlinkSync(fullPath);
    
    console.log('✅ Success:', videoBuffer.length / (1024*1024), 'MB');
    
    return new NextResponse(videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="instagram-reel.mp4"',
        'Content-Length': videoBuffer.length.toString(),
      },
    });
    
  } catch (error: any) {
    console.error('💥 Error:', error.message);
    return NextResponse.json({ 
      error: 'Download failed', 
      details: error.stderr || error.message 
    }, { status: 500 });
  }
}
