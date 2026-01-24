# Dashboard

A multi-app platform for various web utilities. Built with Next.js frontend and FastAPI backend.

## 📱 Available Apps

- **YouTube Subtitles** - Extract subtitles from YouTube videos
- **Reddit Fetcher** - Fetch and analyze Reddit data
- **Site Extractor** - Extract and scrape website content
- **Instagram Reel Downloader** - Download Instagram reels/videos from URLs

## 🏗️ Architecture

### Frontend
- **Location**: `root/dashboard/`
- **Framework**: Next.js 16 + React 19
- **Styling**: TailwindCSS
- **Port**: `http://localhost:3000`

### Backend API
- **Location**: `python-api/`
- **Framework**: FastAPI with yt-dlp
- **Port**: `http://localhost:8000`

## 🚀 Running Locally

### Prerequisites
- Node.js 18+ and npm
- Python 3.11+
- **yt-dlp** (for video downloads)
- Git

### 1. Install yt-dlp

``````bash
# Windows (via pip):
pip install yt-dlp

# Or via winget:
winget install yt-dlp

# Mac:
brew install yt-dlp

# Linux:
sudo apt install yt-dlp
``````

### 2. Setup Backend (Python API)

``````bash
# Navigate to python-api folder
cd python-api

# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the API with auto-reload
uvicorn main:app --reload --host 0.0.0.0 --port 8000
``````

Backend will be available at `http://localhost:8000`

### 3. Setup Frontend (Next.js)

``````bash
# Navigate to dashboard folder
cd root/dashboard

# Install dependencies
npm install

# Create .env.local file
echo "PYTHON_API_URL=http://localhost:8000" > .env.local

# Run development server
npm run dev
``````

Frontend will be available at `http://localhost:3000`

### 4. Access the Application

Open your browser and go to:
- **Dashboard**: http://localhost:3000
- **YouTube Subtitles**: http://localhost:3000/youtube-subtitles
- **Instagram Reel Downloader**: http://localhost:3000/instagram-scraper
- **Python API Docs**: http://localhost:8000/docs

## 📝 How It Works

### YouTube Subtitles
1. User enters YouTube URL in the frontend
2. Request is sent to the Python FastAPI backend via the Next.js proxy
3. Backend uses **yt-dlp** to extract video metadata and download subtitles
4. Subtitles are parsed from XML/JSON format and returned as text
5. Frontend displays the extracted text with copy functionality

### Instagram Reel Downloader Workflow

**Step 1: Extract Top Reels from Instagram HTML**

Use Perplexity Comet (or similar AI browser) with this prompt:

```
Top 10 reels table sorted by VIEWS DESC:

| # | Views | URL |
|---|-------|-----|
| 1 | 1,026 | [https://instagram.com/rasool1mirzaei/reel/DSX](https://instagram.com/rasool1mirzaei/reel/DSX)... |

Views from spans near SVG view icon. URLs from href="/rasool1mirzaei/reel/...". Table only.
```

**Step 2: Download Videos**
1. Copy the reel URLs from the table
2. Paste into the Instagram Reel Downloader at http://localhost:3000/instagram-scraper
3. Click "Extract URLs" then "Download All"
4. Videos are downloaded sequentially to your device

**Step 3: Aggregate Transcriptions**
1. After transcribing videos (using Whisper AI or similar), save transcription files with the format:
   - `instagram-reel-[ID] (transcribed on [DATE]).txt`
   - Example: `instagram-reel-17868991110836 (transcribed on 17-Jan-2026 17-20-36).txt`
2. In the Instagram Reel Downloader page, scroll to the "Aggregate Transcriptions" section
3. Enter the folder path containing your transcription files
4. Click "Aggregate Transcriptions"
5. A single text file will be downloaded with all transcriptions organized by their ID
6. Each transcription section includes:
   - The video ID for easy matching with video files
   - The original filename
   - The full transcription content
   - Clear separators between different transcriptions

**Step 4: Generate Competitor Analysis Slides**

Use **Google NotebookLM** with the aggregated transcriptions file and the following prompt:

```
**Generate Social Media Competition Analysis Slides**

**Input**: Top 10 posts table (URL + Metric like Views/Likes) + matching transcriptions/captions

**Output**: 10-slide presentation analyzing competitor's content strategy

### **Slide Template (1 slide per post):**

**Slide X: #[RANK] - [METRIC]**
[Post URL]
[Metric: X views/likes - #Y ranking]

📊 CONTENT SUMMARY
"What was said": [2-3 sentence summary]
"Why it performed": [3 success factors: hook/value/CTA]

🎯 COMPETITIVE ANALYSIS
✓ Strength #1: [specific tactic]
✓ Strength #2: [production/angle]

**Slides 1-10**: Follow ranking order (highest→lowest metric)

### **Slide 11: Strategy Summary**
📈 PERFORMANCE PATTERNS (Top 3 vs Bottom 3)
1. [Pattern #1 across top posts]
2. [Pattern #2 - format/topic] 
3. [Pattern #3 - timing/CTA]

🏆 VIRAL FORMULA: [Hook Type] + [Value Prop] + [CTA Style]

### **Analysis Instructions:**
- Extract **first 15s hook** → attention grabber
- Identify **core value** → viewer takeaway  
- Analyze **social proof CTA** → like/save/share
- Score **emotional triggers** → fear/greed/curiosity

**Visual Style**: Clean charts, metric bars, success indicators
```

This generates a focused, actionable competitor breakdown with viral content patterns!


## 📦 Tech Stack

**Frontend:**
- Next.js 16
- React 19
- TypeScript
- TailwindCSS

**Backend:**
- FastAPI
- yt-dlp
- Python 3.11+


## 📄 Project Structure

```
├── python-api/
│   ├── main.py              # FastAPI application
│   ├── requirements.txt     # Python dependencies
│   └── scripts/             # Utility scripts
├── root/dashboard/
│   ├── app/
│   │   ├── page.tsx         # Dashboard homepage
│   │   ├── youtube-subtitles/  # YouTube subtitles app
│   │   ├── reddit-fetcher/     # Reddit data fetcher
│   │   ├── site-extractor/     # Web scraper
│   │   ├── instagram-scraper/  # Instagram reel downloader
│   │   └── api/                # Next.js API routes
│   │       ├── download-instagram-video/ # Instagram video API
│   │       └── aggregate-transcriptions/ # Transcription aggregator API
│   ├── components/          # Reusable React components
│   ├── lib/                 # Utility functions
│   ├── public/              # Static assets
│   ├── package.json         # Node dependencies
│   └── tsconfig.json        # TypeScript config
└── README.md
```