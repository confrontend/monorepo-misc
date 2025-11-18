import os
import re

# ---------- Config ----------
INPUT_DIR = "./input"
OUTPUT_DIR = "./output"
PAGES_PER_FILE = 20  # Default; change or make configurable if needed

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ---------- Helpers ----------
def split_text_by_page_marker(content, page_marker="--- Page "):
    # Split at --- Page X --- (keeping the marker)
    chunks = re.split(rf"(?=^{page_marker}\d+ ---$)", content, flags=re.MULTILINE)
    return [chunk.strip() for chunk in chunks if chunk.strip()]

def chunk_pages(pages, chunk_size):
    for i in range(0, len(pages), chunk_size):
        yield pages[i:i + chunk_size]

def process_file(filepath, pages_per_file):
    filename = os.path.splitext(os.path.basename(filepath))[0]
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    pages = split_text_by_page_marker(content)
    for idx, group in enumerate(chunk_pages(pages, pages_per_file), 1):
        output_file = os.path.join(OUTPUT_DIR, f"{filename}_part{idx}.txt")
        with open(output_file, "w", encoding="utf-8") as out:
            out.write("\n\n".join(group))
        print(f"✅ Wrote {output_file}")

# ---------- Main ----------
def main(pages_per_file=PAGES_PER_FILE):
    txt_files = [f for f in os.listdir(INPUT_DIR) if f.lower().endswith(".txt")]
    if not txt_files:
        print("⚠ No .txt files found in input folder.")
        return

    for file in txt_files:
        process_file(os.path.join(INPUT_DIR, file), pages_per_file)

if __name__ == "__main__":
    main()
