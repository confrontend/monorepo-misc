from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
import os
import re
import json
import yt_dlp
from pathlib import Path
import logging
import sys
import xml.etree.ElementTree as ET
import html
import asyncio

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class VideoRequest(BaseModel):
    url: str

def clean_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name)

def extract_text(subtitle_path):
    """Extract text from YouTube subtitle file (srv3/xml or json3 format)"""
    try:
        with open(subtitle_path, "r", encoding="utf-8") as f:
            content = f.read()
        
        if content.strip().startswith('<?xml') or content.strip().startswith('<'):
            return extract_text_from_xml(content)
        else:
            return extract_text_from_json(content)
            
    except Exception as e:
        logger.error(f"Error extracting text: {e}")
        raise

def extract_text_from_xml(xml_content):
    """Extract text from XML subtitle format (srv3)"""
    try:
        root = ET.fromstring(xml_content)
        words = []
        
        p_elements = list(root.iter('p'))
        
        for p_elem in p_elements:
            text_content = ''.join(p_elem.itertext())
            
            if text_content:
                text = html.unescape(text_content.strip())
                text = ' '.join(text.split())
                if text:
                    words.append(text)
        
        return " ".join(words).strip()
        
    except Exception as e:
        logger.error(f"Error parsing XML: {e}")
        raise

def extract_text_from_json(json_content):
    """Extract text from JSON subtitle format (json3)"""
    try:
        data = json.loads(json_content)
        words = []
        
        if "events" in data:
            for event in data.get("events", []):
                if "segs" in event:
                    for seg in event["segs"]:
                        t = seg.get("utf8", "").strip()
                        if t and t != "\n":
                            words.append(t)
            
            if words:
                return " ".join(words).strip()
        
        raise ValueError("No recognized subtitle format found in JSON")
    except json.JSONDecodeError as e:
        logger.error(f"JSON decode error: {e}")
        raise

@app.get("/")
def read_root():
    return {"status": "Python API is running"}

async def generate_progress(url: str):
    """Generate progress updates as JSON stream"""
    output_dir = Path("temp_output")
    output_dir.mkdir(exist_ok=True)
    
    try:
        # Check if it's a playlist
        ydl_opts_info = {
            "quiet": True,
            "extract_flat": True,
        }
        
        is_playlist = False
        video_urls = [url]
        
        with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
            info = ydl.extract_info(url, download=False)
            
            if info.get('_type') == 'playlist':
                is_playlist = True
                playlist_count = len(info.get('entries', []))
                
                yield json.dumps({
                    "type": "progress",
                    "message": f"📋 Found playlist with {playlist_count} videos",
                    "current": 0,
                    "total": playlist_count
                }) + "\n"
                
                video_urls = []
                for entry in info['entries']:
                    if entry:
                        video_urls.append(entry.get('url') or f"https://www.youtube.com/watch?v={entry['id']}")
            else:
                yield json.dumps({
                    "type": "progress",
                    "message": "🎥 Processing single video...",
                    "current": 0,
                    "total": 1
                }) + "\n"
        
        # Process each video
        all_subtitles = []
        
        for idx, video_url in enumerate(video_urls, 1):
            yield json.dumps({
                "type": "progress",
                "message": f"⏳ Processing video {idx}/{len(video_urls)}...",
                "current": idx - 1,
                "total": len(video_urls)
            }) + "\n"
            
            ydl_opts = {
                "writesubtitles": True,
                "writeautomaticsub": True,
                "subtitlesformat": "srv3",
                "subtitleslangs": ["en"],
                "skip_download": True,
                "outtmpl": str(output_dir / "%(title)s.%(ext)s"),
                "quiet": True,
                "no_warnings": True,
                "noplaylist": True,
                "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "referer": "https://www.youtube.com/"
            }
            
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(video_url, download=False)
                    video_title = info.get('title', 'Unknown')
                    
                    yield json.dumps({
                        "type": "progress",
                        "message": f"📥 Downloading: {video_title[:50]}...",
                        "current": idx - 0.5,
                        "total": len(video_urls)
                    }) + "\n"
                    
                    ydl.download([video_url])
                
                subtitle_files = (
                    list(output_dir.glob("*.srv3")) + 
                    list(output_dir.glob("*.json3")) +
                    list(output_dir.glob("*.vtt")) +
                    list(output_dir.glob("*.ttml"))
                )
                
                if subtitle_files:
                    subtitle_path = subtitle_files[0]
                    text = extract_text(subtitle_path)
                    
                    subtitle_entry = f"\n\n{'='*80}\n📹 {video_title}\n{'='*80}\n\n{text}"
                    all_subtitles.append(subtitle_entry)
                    
                    yield json.dumps({
                        "type": "progress",
                        "message": f"✅ Completed: {video_title[:50]}...",
                        "current": idx,
                        "total": len(video_urls)
                    }) + "\n"
                else:
                    all_subtitles.append(f"\n\n{'='*80}\n📹 {video_title}\n{'='*80}\n\n[No subtitles available]")
                
            except Exception as e:
                logger.error(f"Error processing video {idx}: {e}")
                all_subtitles.append(f"\n\n{'='*80}\n📹 Video {idx}\n{'='*80}\n\n[Error: {str(e)}]")
            
            # Cleanup after each video
            for file in output_dir.glob("*"):
                file.unlink()
        
        # Send final result
        combined_text = "\n".join(all_subtitles).strip()
        
        if is_playlist:
            title = f"Playlist: {len(video_urls)} videos"
        else:
            title = info.get('title', 'Unknown')
        
        yield json.dumps({
            "type": "complete",
            "success": True,
            "title": title,
            "text": combined_text,
            "video_count": len(video_urls),
            "message": f"✨ Completed! Extracted subtitles from {len(video_urls)} video(s)"
        }) + "\n"
        
    except Exception as e:
        logger.error(f"Error: {e}")
        yield json.dumps({
            "type": "error",
            "message": str(e)
        }) + "\n"

@app.post("/api/youtube-subtitles")
async def download_subtitles(request: VideoRequest):
    return StreamingResponse(
        generate_progress(request.url),
        media_type="application/x-ndjson"
    )

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting server on port {port}")
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0", 
        port=port,
        reload=True
    )
