import os
import fitz  # PyMuPDF
import re

# -------- Config --------
INPUT_DIR = "./input"
OUTPUT_DIR = "./output"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# -------- Safe filename generator --------
def sanitize_filename(title):
    return re.sub(r'[<>:"/\\|?*]', '_', title).strip()

# -------- Extract entire PDF into one .txt file --------
def extract_pdf_to_txt(pdf_path):
    doc = fitz.open(pdf_path)
    text = ""

    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        text += page.get_text()

    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    safe_name = sanitize_filename(base_name)
    print(safe_name)
    output_path = os.path.join(OUTPUT_DIR, f"{safe_name}.txt")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(text.strip())

    print(f"✅ Saved: {output_path}")

# -------- Main --------
def main():
    pdf_files = [f for f in os.listdir(INPUT_DIR) if f.lower().endswith(".pdf")]

    if not pdf_files:
        print("⚠ No PDF files found in ./input")
        return

    for file in pdf_files:
        full_path = os.path.join(INPUT_DIR, file)
        extract_pdf_to_txt(full_path)

if __name__ == "__main__":
    main()
