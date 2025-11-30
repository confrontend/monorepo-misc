from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import os
import re
import json
import yt_dlp
from pathlib import Path

app = FastAPI()

# Allow your Next.js app to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify your Vercel domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class VideoRequest(BaseModel):
    url: str

def clean_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name)

def extract_text(json_path):
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    words = []
    for event in data.get("events", []):
        if "segs" not in event:
            continue
        for seg in event["segs"]:
            t = seg.get("utf8", "").strip()
            if t and t != "\n":
                words.append(t)
    
    return " ".join(words).strip()

@app.get("/")
def read_root():
    return {"status": "Python API is running"}

@app.post("/api/youtube-subtitles")
async def download_subtitles(request: VideoRequest):
    try:
        url = request.url
        output_dir = Path("temp_output")
        output_dir.mkdir(exist_ok=True)
        
        ydl_opts = {
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitlesformat": "json3",
            "subtitleslangs": ["en"],
            "skip_download": True,
            "outtmpl": str(output_dir / "%(title)s.%(ext)s"),
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            ydl.download([url])
            title = info["title"]
        
        # Find and process the subtitle file
        subtitle_files = list(output_dir.glob("*.json3"))
        
        if not subtitle_files:
            raise HTTPException(status_code=404, detail="No subtitles found")
        
        json_path = subtitle_files[0]
        text = extract_text(json_path)
        
        # Cleanup
        for file in output_dir.glob("*"):
            file.unlink()
        
        return {
            "success": True,
            "title": title,
            "text": text,
            "message": "Subtitles extracted successfully"
        }
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
