from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import re
import json
import yt_dlp
from pathlib import Path
import logging
import sys

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

# Allow your Next.js app to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class VideoRequest(BaseModel):
    url: str

def clean_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name)

def extract_text(json_path):
    """Extract text from YouTube subtitle JSON with detailed logging"""
    logger.info(f"Attempting to extract text from: {json_path}")
    
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        logger.info(f"JSON file loaded successfully. Keys: {list(data.keys())}")
        
        # Try multiple extraction methods
        words = []
        
        # Method 1: Standard json3 format with events
        if "events" in data:
            logger.info(f"Found 'events' key with {len(data['events'])} events")
            for i, event in enumerate(data.get("events", [])):
                if "segs" in event:
                    for seg in event["segs"]:
                        t = seg.get("utf8", "").strip()
                        if t and t != "\n":
                            words.append(t)
                elif "dDurationMs" in event and "segs" not in event:
                    # Some events might be timing markers
                    continue
            
            if words:
                logger.info(f"Extracted {len(words)} text segments using Method 1 (events/segs)")
                return " ".join(words).strip()
        
        # Method 2: Try direct 'body' field (some subtitle formats)
        if "body" in data:
            logger.info("Found 'body' key, attempting extraction")
            for item in data.get("body", []):
                if isinstance(item, dict) and "body" in item:
                    words.append(item["body"])
            
            if words:
                logger.info(f"Extracted {len(words)} text segments using Method 2 (body)")
                return " ".join(words).strip()
        
        # Method 3: Try 'text' field (simple format)
        if "text" in data:
            logger.info("Found direct 'text' key")
            return data["text"]
        
        # If we get here, log the structure for debugging
        logger.error(f"Could not extract text. JSON structure: {json.dumps(data, indent=2)[:500]}")
        raise ValueError("No recognized subtitle format found in JSON")
        
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse JSON: {e}")
        raise
    except Exception as e:
        logger.error(f"Error extracting text: {e}")
        raise

@app.get("/")
def read_root():
    return {"status": "Python API is running"}

@app.post("/api/youtube-subtitles")
async def download_subtitles(request: VideoRequest):
    logger.info(f"=== YouTube Subtitles Request ===")
    logger.info(f"URL: {request.url}")
    
    try:
        url = request.url
        output_dir = Path("temp_output")
        output_dir.mkdir(exist_ok=True)
        logger.info(f"Output directory: {output_dir.absolute()}")
        
        ydl_opts = {
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitlesformat": "json3",
            "subtitleslangs": ["en"],
            "skip_download": True,
            "outtmpl": str(output_dir / "%(title)s.%(ext)s"),
            "quiet": False,
            "no_warnings": False,
        }
        
        logger.info(f"yt-dlp options: {ydl_opts}")
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            logger.info("Extracting video info...")
            info = ydl.extract_info(url, download=False)
            
            logger.info(f"Video title: {info.get('title', 'Unknown')}")
            logger.info(f"Video ID: {info.get('id', 'Unknown')}")
            logger.info(f"Available subtitles: {list(info.get('subtitles', {}).keys())}")
            logger.info(f"Available automatic captions: {list(info.get('automatic_captions', {}).keys())}")
            
            logger.info("Downloading subtitles...")
            ydl.download([url])
            title = info["title"]
        
        # Find and process the subtitle file
        subtitle_files = list(output_dir.glob("*.json3"))
        logger.info(f"Found {len(subtitle_files)} subtitle files: {[f.name for f in subtitle_files]}")
        
        if not subtitle_files:
            # List all files in directory for debugging
            all_files = list(output_dir.glob("*"))
            logger.error(f"No .json3 files found. All files in directory: {[f.name for f in all_files]}")
            raise HTTPException(status_code=404, detail="No subtitles found")
        
        json_path = subtitle_files[0]
        logger.info(f"Processing subtitle file: {json_path.name}")
        logger.info(f"File size: {json_path.stat().st_size} bytes")
        
        text = extract_text(json_path)
        logger.info(f"Successfully extracted {len(text)} characters of text")
        
        # Cleanup
        logger.info("Cleaning up temporary files...")
        for file in output_dir.glob("*"):
            file.unlink()
            logger.info(f"Deleted: {file.name}")
        
        return {
            "success": True,
            "title": title,
            "text": text,
            "message": "Subtitles extracted successfully"
        }
    
    except yt_dlp.utils.DownloadError as e:
        logger.error(f"yt-dlp download error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Download error: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    logger.info(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
