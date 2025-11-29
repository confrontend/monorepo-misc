import os
import re
import json
import yt_dlp

PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLak-S4mMOFYGUmcF6yNerN4NlkkPGBfyV"

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

def find_playlist_folder(base_dir, clean_name):
    for entry in os.listdir(base_dir):
        full = os.path.join(base_dir, entry)
        if os.path.isdir(full) and entry.startswith(clean_name[:10]):
            return full
    return None


def download_plain_text(url):
    base_dir = "output"      # <-- FIXED LINE

    ydl_opts = {
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "json3",
        "subtitleslangs": ["en"],
        "skip_download": True,
        "outtmpl": f"{base_dir}/%(playlist_title)s/%(title)s.%(ext)s",
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    # Playlist info
    info = yt_dlp.YoutubeDL({"skip_download": True}).extract_info(url, download=False)
    raw_name = info["title"]
    clean_name = clean_filename(raw_name)

    # Find the actual folder yt-dlp created inside output/
    folder = find_playlist_folder(base_dir, clean_name)
    if not folder:
        raise Exception(f"Could not find downloaded folder for playlist: {clean_name}")

    print("Detected folder:", folder)

    # Process each .json3 → .txt
    for filename in os.listdir(folder):
        if filename.endswith(".json3"):
            json_path = os.path.join(folder, filename)
            txt_path = json_path.replace(".json3", ".txt")

            text = extract_text(json_path)

            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text)

            print("Created:", txt_path)

            os.remove(json_path)
            print("Deleted JSON:", json_path)


if __name__ == "__main__":
    download_plain_text(PLAYLIST_URL)
