from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pathlib import Path
from typing import Any, AsyncIterator, Optional
import asyncio
import html
import json
import logging
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET

import yt_dlp


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
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


class SubtitleRequest(BaseModel):
    url: Optional[str] = None
    html: Optional[str] = None
    max_downloads: Optional[int] = None


PLAYLIST_URL_PATTERN = re.compile(
    r"(?:(?:https?:)?//(?:www\.)?youtube\.com)?/playlist\?list=([A-Za-z0-9_-]+)",
    re.IGNORECASE,
)
YOUTUBE_ACCESS_DELAY_SECONDS = 1.0


def clean_filename(name: str, max_length: int = 100) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return (cleaned[:max_length] or "untitled").strip(" .")


def create_channel_directory(channel_name: str) -> Path:
    default_root = Path(__file__).resolve().parent.parent / "vantage" / "articles"
    output_root = Path(os.environ.get("SUBTITLE_OUTPUT_DIR", str(default_root)))
    channel_directory = output_root / clean_filename(channel_name)
    channel_directory.mkdir(parents=True, exist_ok=True)
    return channel_directory


def stream_event(event_type: str, **payload: Any) -> str:
    return json.dumps(
        {"type": event_type, **payload}, ensure_ascii=False
    ) + "\n"


def extract_playlist_urls(html_content: str) -> list[str]:
    """Extract unique YouTube playlist URLs in document order."""
    normalized = html.unescape(html_content).replace("\\/", "/")
    playlist_ids: list[str] = []
    seen: set[str] = set()

    for match in PLAYLIST_URL_PATTERN.finditer(normalized):
        playlist_id = match.group(1)
        if playlist_id not in seen:
            seen.add(playlist_id)
            playlist_ids.append(playlist_id)

    return [
        f"https://www.youtube.com/playlist?list={playlist_id}"
        for playlist_id in playlist_ids
    ]


def entry_to_video_url(entry: dict[str, Any]) -> Optional[str]:
    candidate = entry.get("webpage_url") or entry.get("url")

    if not candidate and entry.get("id"):
        candidate = f"https://www.youtube.com/watch?v={entry['id']}"

    if not candidate:
        return None

    if candidate.startswith(("http://", "https://")):
        return candidate

    if candidate.startswith("/watch"):
        return f"https://www.youtube.com{candidate}"

    return f"https://www.youtube.com/watch?v={candidate}"


def extract_text(subtitle_path: Path) -> str:
    """Extract readable text from srv3/XML, JSON3, VTT, or TTML subtitles."""
    content = subtitle_path.read_text(encoding="utf-8")
    suffix = subtitle_path.suffix.lower()

    if suffix in {".vtt", ".ttml"}:
        return extract_text_from_markup(content)

    if content.lstrip().startswith(("<?xml", "<")):
        return extract_text_from_xml(content)

    return extract_text_from_json(content)


def extract_text_from_markup(content: str) -> str:
    lines: list[str] = []
    for raw_line in content.splitlines():
        line = re.sub(r"<[^>]+>", "", raw_line)
        line = html.unescape(line).strip()
        if not line or line == "WEBVTT" or re.match(r"^\d+$", line):
            continue
        if " --> " in line:
            continue
        lines.append(" ".join(line.split()))
    return " ".join(lines).strip()


def extract_text_from_xml(xml_content: str) -> str:
    root = ET.fromstring(xml_content)
    words: list[str] = []

    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] not in {"p", "text"}:
            continue
        text_content = "".join(element.itertext())
        text = " ".join(html.unescape(text_content).split())
        if text:
            words.append(text)

    return " ".join(words).strip()


def extract_text_from_json(json_content: str) -> str:
    data = json.loads(json_content)
    words: list[str] = []

    for event in data.get("events", []):
        for segment in event.get("segs", []):
            text = segment.get("utf8", "").strip()
            if text and text != "\\n":
                words.append(text)

    if not words:
        raise ValueError("No recognized subtitle text found")

    return " ".join(words).strip()


def metadata_options() -> dict[str, Any]:
    return {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "ignoreerrors": True,
        "sleep_interval_requests": YOUTUBE_ACCESS_DELAY_SECONDS,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "referer": "https://www.youtube.com/",
    }


def subtitle_options(output_dir: Path) -> dict[str, Any]:
    return {
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "srv3",
        "subtitleslangs": ["en"],
        "skip_download": True,
        "outtmpl": str(output_dir / "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "sleep_interval_requests": YOUTUBE_ACCESS_DELAY_SECONDS,
        "sleep_interval_subtitles": 1,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "referer": "https://www.youtube.com/",
    }


def playlist_entries(
    url: str,
) -> tuple[str, list[str], str, bool, Optional[str]]:
    """Return title, video URLs, channel name, playlist flag, and an error."""
    try:
        with yt_dlp.YoutubeDL(metadata_options()) as ydl:
            info = ydl.extract_info(url, download=False)

        if not info:
            return (
                "Unknown playlist",
                [],
                "Unknown channel",
                True,
                "No metadata returned by yt-dlp",
            )

        entries = [entry for entry in (info.get("entries") or []) if entry]
        if info.get("_type") == "playlist" or entries:
            videos = [
                video_url
                for entry in entries
                if (video_url := entry_to_video_url(entry))
            ]
            entries_channel = next(
                (
                    entry.get("channel") or entry.get("uploader")
                    for entry in entries
                    if entry.get("channel") or entry.get("uploader")
                ),
                None,
            )
            channel = info.get("channel") or info.get("uploader") or entries_channel
            return (
                info.get("title") or "Untitled playlist",
                videos,
                channel or "Unknown channel",
                True,
                None,
            )

        video_url = entry_to_video_url(info)
        if not video_url:
            return (
                info.get("title") or "Unknown video",
                [],
                "Unknown channel",
                False,
                "No video URL returned",
            )
        channel = info.get("channel") or info.get("uploader") or "Unknown channel"
        return info.get("title") or "Single video", [video_url], channel, False, None
    except Exception as exc:
        logger.exception("Could not inspect %s", url)
        return "Unavailable playlist", [], "Unknown channel", True, str(exc)


async def generate_progress(
    url: Optional[str] = None,
    html_content: Optional[str] = None,
    max_downloads: Optional[int] = None,
) -> AsyncIterator[str]:
    """Discover playlists/videos and stream detailed extraction progress."""
    try:
        if html_content:
            source_urls = extract_playlist_urls(html_content)
            yield stream_event(
                "discovery",
                phase="html",
                message=f"Found {len(source_urls)} unique playlist URL(s) in the HTML file",
                current=0,
                total=len(source_urls),
                playlist_total=len(source_urls),
            )
            if not source_urls:
                raise ValueError("No YouTube playlist URLs were found in the HTML file")
        elif url:
            source_urls = [url.strip()]
        else:
            raise ValueError("Provide a YouTube URL or an HTML file")

        playlists: list[dict[str, Any]] = []

        for playlist_index, playlist_url in enumerate(source_urls, 1):
            await asyncio.sleep(YOUTUBE_ACCESS_DELAY_SECONDS)
            yield stream_event(
                "discovery",
                phase="playlist",
                message=f"Reading playlist {playlist_index}/{len(source_urls)}...",
                current=playlist_index - 1,
                total=len(source_urls),
                playlist_index=playlist_index,
                playlist_total=len(source_urls),
                playlist_url=playlist_url,
            )

            title, videos, channel, is_playlist, error = playlist_entries(playlist_url)
            playlists.append(
                {
                    "title": title,
                    "channel": channel,
                    "is_playlist": is_playlist,
                    "url": playlist_url,
                    "videos": videos,
                    "error": error,
                }
            )

            yield stream_event(
                "playlist_found",
                message=(
                    f"Found {len(videos)} video(s) in {title}"
                    if not error
                    else f"Could not read {title}: {error}"
                ),
                playlist_index=playlist_index,
                playlist_total=len(source_urls),
                playlist_title=title,
                playlist_url=playlist_url,
                video_total=len(videos),
                status="ready" if not error else "error",
            )

        if max_downloads and max_downloads > 0:
            remaining = max_downloads
            for playlist in playlists:
                playlist["videos"] = playlist["videos"][:remaining]
                remaining = max(0, remaining - len(playlist["videos"]))

        total_videos = sum(len(playlist["videos"]) for playlist in playlists)
        if total_videos == 0:
            errors = [playlist["error"] for playlist in playlists if playlist["error"]]
            raise ValueError(errors[0] if errors else "No videos were found")

        output_root = Path(
            os.environ.get(
                "SUBTITLE_OUTPUT_DIR",
                str(Path(__file__).resolve().parent.parent / "vantage" / "articles"),
            )
        )
        output_root.mkdir(parents=True, exist_ok=True)
        processed_videos = 0
        successful_videos = 0
        all_subtitles: list[str] = []
        channel_subtitles: dict[str, list[str]] = {}
        channel_directories: dict[str, Path] = {}

        with tempfile.TemporaryDirectory(prefix="youtube-subtitles-") as temp_dir:
            output_dir = Path(temp_dir)

            for playlist_index, playlist in enumerate(playlists, 1):
                playlist_title = playlist["title"]
                videos = playlist["videos"]
                channel_name = playlist["channel"] or "Unknown channel"
                playlist_directory = channel_directories.get(channel_name)
                if channel_name != "Unknown channel":
                    playlist_directory = channel_directories.setdefault(
                        channel_name, create_channel_directory(channel_name)
                    )
                    channel_subtitles.setdefault(channel_name, [])
                playlist_subtitles: list[str] = []

                yield stream_event(
                    "playlist_start",
                    message=f"Starting playlist {playlist_index}/{len(playlists)}: {playlist_title}",
                    playlist_index=playlist_index,
                    playlist_total=len(playlists),
                    playlist_title=playlist_title,
                    playlist_url=playlist["url"],
                    video_total=len(videos),
                    overall_current=processed_videos,
                    overall_total=total_videos,
                    status="processing",
                )

                if playlist["error"]:
                    yield stream_event(
                        "playlist_error",
                        message=playlist["error"],
                        playlist_index=playlist_index,
                        playlist_total=len(playlists),
                        playlist_title=playlist_title,
                        playlist_url=playlist["url"],
                        video_total=0,
                        status="error",
                    )
                    continue

                for video_index, video_url in enumerate(videos, 1):
                    await asyncio.sleep(YOUTUBE_ACCESS_DELAY_SECONDS)
                    title = f"Video {video_index}"
                    partial_text = ""
                    base_progress = {
                        "playlist_index": playlist_index,
                        "playlist_total": len(playlists),
                        "playlist_title": playlist_title,
                        "playlist_url": playlist["url"],
                        "video_index": video_index,
                        "video_total": len(videos),
                        "overall_current": processed_videos,
                        "overall_total": total_videos,
                    }

                    yield stream_event(
                        "progress",
                        phase="video",
                        message=f"Processing playlist {playlist_index}/{len(playlists)} - video {video_index}/{len(videos)}...",
                        **base_progress,
                    )

                    try:
                        with yt_dlp.YoutubeDL(subtitle_options(output_dir)) as ydl:
                            info = ydl.extract_info(video_url, download=False)
                            video_id = None
                            if info:
                                title = info.get("title") or title
                                video_id = info.get("id")
                                video_channel = info.get("channel") or info.get("uploader")
                                if video_channel and channel_name == "Unknown channel":
                                    channel_name = video_channel
                                    playlist_directory = channel_directories.setdefault(
                                        channel_name,
                                        create_channel_directory(channel_name),
                                    )
                                    channel_subtitles.setdefault(channel_name, [])

                            yield stream_event(
                                "progress",
                                phase="download",
                                message=f"Downloading subtitles: {title[:80]}",
                                **{**base_progress, "title": title},
                            )
                            await asyncio.sleep(YOUTUBE_ACCESS_DELAY_SECONDS)
                            ydl.download([video_url])

                        candidates = [
                            path
                            for path in output_dir.iterdir()
                            if path.is_file()
                            and path.suffix.lower() in {".srv3", ".json3", ".vtt", ".ttml"}
                            and (not video_id or path.name.startswith(f"{video_id}."))
                        ]
                        candidates.sort(
                            key=lambda path: {
                                ".srv3": 0,
                                ".json3": 1,
                                ".vtt": 2,
                                ".ttml": 3,
                            }.get(path.suffix.lower(), 9)
                        )

                        if candidates:
                            text = extract_text(candidates[0])
                            successful_videos += 1
                            subtitle_text = text or "[Subtitle file was empty]"
                        else:
                            subtitle_text = "[No English subtitles available]"

                        partial_text = (
                            f"\n\n{'=' * 80}\nPLAYLIST: {playlist_title}\nVIDEO: {title}\nURL: {video_url}\n{'=' * 80}\n\n{subtitle_text}"
                        )
                        all_subtitles.append(partial_text)
                    except Exception as exc:
                        logger.exception("Error processing %s", video_url)
                        partial_text = (
                            f"\n\n{'=' * 80}\nPLAYLIST: {playlist_title}\nVIDEO: {title}\nURL: {video_url}\n{'=' * 80}\n\n[Error: {exc}]"
                        )
                        all_subtitles.append(partial_text)
                    finally:
                        for path in output_dir.iterdir():
                            if path.is_file():
                                path.unlink(missing_ok=True)

                    if playlist_directory is None:
                        playlist_directory = channel_directories.setdefault(
                            channel_name, create_channel_directory(channel_name)
                        )
                        channel_subtitles.setdefault(channel_name, [])

                    video_file = playlist_directory / (
                        f"{clean_filename(title, max_length=180)}.txt"
                    )
                    video_file.write_text(
                        partial_text.strip() + "\n", encoding="utf-8"
                    )
                    playlist_subtitles.append(partial_text)
                    channel_subtitles[channel_name].append(partial_text)
                    processed_videos += 1
                    aggregate_file = playlist_directory / "ALL_SUBTITLES.txt"
                    aggregate_file.write_text(
                        "\n".join(channel_subtitles[channel_name]).strip() + "\n",
                        encoding="utf-8",
                    )
                    yield stream_event(
                        "partial_result",
                        phase="partial_result",
                        message=f"Results ready for {title[:80]}",
                        text=partial_text,
                        title=title,
                        video_count=processed_videos,
                        successful_video_count=successful_videos,
                        saved_file=str(video_file),
                        output_directory=str(playlist_directory),
                        **{
                            **base_progress,
                            "overall_current": processed_videos,
                        },
                    )
                    yield stream_event(
                        "progress",
                        phase="complete_video",
                        message=f"Completed {processed_videos}/{total_videos}: {title[:80]}",
                        **{
                            **base_progress,
                            "title": title,
                            "overall_current": processed_videos,
                        },
                    )

                playlist_file = None
                if playlist["is_playlist"] and playlist_subtitles:
                    playlist_file = playlist_directory / (
                        f"{clean_filename(playlist_title)}.txt"
                    )
                    playlist_file.write_text(
                        "\n".join(playlist_subtitles).strip() + "\n",
                        encoding="utf-8",
                    )

                yield stream_event(
                    "playlist_complete",
                    message=f"Completed playlist: {playlist_title}",
                    playlist_index=playlist_index,
                    playlist_total=len(playlists),
                    playlist_title=playlist_title,
                    playlist_url=playlist["url"],
                    video_total=len(videos),
                    overall_current=processed_videos,
                    overall_total=total_videos,
                    status="complete",
                    saved_file=str(playlist_file) if playlist_file else None,
                    output_directory=str(playlist_directory or output_root),
                )

        if html_content:
            result_title = f"HTML import: {len(playlists)} playlist(s)"
        elif len(playlists) == 1:
            result_title = playlists[0]["title"]
        else:
            result_title = f"YouTube import: {len(playlists)} playlists"

        combined_text = "\n".join(all_subtitles).strip()
        aggregate_files = []
        for channel_name, subtitles in channel_subtitles.items():
            aggregate_file = channel_directories[channel_name] / "ALL_SUBTITLES.txt"
            aggregate_file.write_text(
                "\n".join(subtitles).strip() + "\n", encoding="utf-8"
            )
            aggregate_files.append(aggregate_file)

        yield stream_event(
            "complete",
            success=True,
            title=result_title,
            text=combined_text,
            video_count=processed_videos,
            playlist_count=len(playlists),
            successful_video_count=successful_videos,
            message=f"Completed {processed_videos} video(s) across {len(playlists)} playlist(s)",
            output_directory=(
                str(next(iter(channel_directories.values())))
                if len(channel_directories) == 1
                else str(output_root)
            ),
            aggregate_file=str(aggregate_files[0]) if len(aggregate_files) == 1 else None,
        )
    except Exception as exc:
        logger.exception("Subtitle extraction failed")
        yield stream_event("error", message=str(exc))


@app.get("/")
def read_root() -> dict[str, str]:
    return {"status": "Python API is running"}


@app.post("/api/youtube-subtitles")
async def download_subtitles(request: SubtitleRequest) -> StreamingResponse:
    return StreamingResponse(
        generate_progress(
            url=request.url,
            html_content=request.html,
            max_downloads=request.max_downloads,
        ),
        media_type="application/x-ndjson",
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    logger.info("Starting server on port %s", port)
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
