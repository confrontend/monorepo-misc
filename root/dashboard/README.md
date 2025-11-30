# YouTube Subtitles Dashboard

A full-stack application that downloads and extracts subtitles from YouTube videos. Built with Next.js frontend and FastAPI Python backend.

## 🏗️ Architecture

### Frontend (Next.js)
- **Location**: `root/dashboard/`
- **Framework**: Next.js 16 with React
- **Port**: `http://localhost:3000`
- **Features**: Dashboard UI with cards linking to different apps

### Backend (Python API)
- **Location**: `python-api/`
- **Framework**: FastAPI with yt-dlp
- **Port**: `http://localhost:8000`
- **Features**: YouTube subtitle extraction, supports multiple formats (srv3, json3, vtt)

## 🚀 Running Locally

### Prerequisites
- Node.js 18+ and npm
- Python 3.11+
- Git

### 1. Setup Backend (Python API)

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

### 2. Setup Frontend (Next.js)

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

### 3. Access the Application

Open your browser and go to:
- **Dashboard**: http://localhost:3000
- **YouTube Subtitles**: http://localhost:3000/youtube-subtitles
- **Python API Docs**: http://localhost:8000/docs

## 📝 How It Works

### Development Flow
1. **User enters YouTube URL** in the frontend form
2. **Next.js API route** (`/api/youtube-subtitles`) receives the request
3. **Request is proxied** to local Python backend at `localhost:8000`
4. **Python backend** uses `yt-dlp` to:
   - Extract video metadata
   - Download subtitle files (.srv3 format)
   - Parse XML and extract text
   - Clean up temporary files
5. **Response returns** through Next.js to the frontend
6. **Text displays** inline with copy-to-clipboard functionality

### Production Setup

**Backend (Railway)**
- Python API deployed to: `https://reliable-strength-production.up.railway.app`
- Auto-deploys on git push
- Environment: Production (no auto-reload)

**Frontend (Your hosting)**
- Set environment variable: `PYTHON_API_URL=https://reliable-strength-production.up.railway.app`
- Next.js app connects to production Python API

**Configuration**
``````bash
# Development (.env.local)
PYTHON_API_URL=http://localhost:8000

# Production (hosting platform)
PYTHON_API_URL=https://reliable-strength-production.up.railway.app
``````

## 🛠️ Development Tips

### Auto-Reload
Both servers support hot-reload:
- **Python**: uvicorn's `--reload` flag watches for file changes
- **Next.js**: Turbopack automatically reloads on save

### Testing Playlists
The app automatically detects playlist URLs and extracts only the first video to avoid long processing times.

### Debugging
- **Python logs**: Check terminal running uvicorn
- **Next.js logs**: Check terminal running `npm run dev`
- **API inspection**: Visit http://localhost:8000/docs for interactive API documentation

## 📦 Tech Stack

- **Frontend**: Next.js 16, React, TailwindCSS
- **Backend**: FastAPI, yt-dlp, Python 3.11
- **Deployment**: Railway (Backend), Your hosting (Frontend)

## 🔧 Troubleshooting

**Problem**: "No subtitles found"
- **Solution**: Video may not have English subtitles or auto-captions

**Problem**: Playlist takes too long
- **Solution**: App now automatically processes only first video from playlists

**Problem**: Backend connection refused
- **Solution**: Ensure Python API is running on port 8000 and `.env.local` points to correct URL

## 📄 Project Structure

``````
.
├── python-api/
│   ├── main.py              # FastAPI application
│   ├── requirements.txt     # Python dependencies
│   └── temp_output/         # Temporary subtitle files (auto-cleanup)
├── root/dashboard/
│   ├── app/
│   │   ├── page.tsx         # Dashboard homepage
│   │   ├── youtube-subtitles/
│   │   │   └── page.tsx     # YouTube subtitles UI
│   │   └── api/
│   │       └── youtube-subtitles/
│   │           └── route.ts # API proxy to Python backend
│   ├── .env.local           # Local environment variables
│   └── package.json         # Node dependencies
└── README.md
``````

## 🎯 Next Steps

- [ ] Add support for multiple videos from playlists
- [ ] Implement progress tracking for long operations
- [ ] Add support for other languages beyond English
- [ ] Create download-as-file option
- [ ] Add timestamp preservation from subtitles

---

Built with ❤️ for faster YouTube research and content analysis.
"@ | Out-File -FilePath README.md -Encoding utf8
```

## Option 3: Use VS Code

1. Open VS Code in your project root
2. Press `Ctrl+N` to create a new file
3. Paste the content
4. Press `Ctrl+S` and name it `README.md`

Would you like me to help you with any of these methods?