import os
import logging
from pdf2image import convert_from_path, pdfinfo_from_path
import pytesseract
from tqdm import tqdm

# ---------- Configuration ----------
lang = 'eng'  # Persian
input_dir = "./input"
output_dir = "./output"
os.makedirs(output_dir, exist_ok=True)

# ---------- Logging ----------
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ---------- Convert PDF to images with progress ----------
def convert_pdf_to_images(path, dpi=300):
    try:
        info = pdfinfo_from_path(path)
        total_pages = info.get("Pages", 0)
        logging.info(f"Converting {total_pages} pages: {os.path.basename(path)}")

        pages = []
        for i in tqdm(range(1, total_pages + 1), desc="Converting PDF"):
            image = convert_from_path(path, dpi=dpi, first_page=i, last_page=i)[0]
            pages.append(image)

        return pages
    except Exception as e:
        logging.error("Failed to convert PDF to images.")
        logging.error(str(e))
        return []

# ---------- Process one PDF with incremental writing ----------
def process_pdf(pdf_path):
    pages = convert_pdf_to_images(pdf_path)
    if not pages:
        return

    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    output_path = os.path.join(output_dir, f"output_{base_name}.txt")

    logging.info(f"🔎 OCR started for: {os.path.basename(pdf_path)}")
    try:
        with open(output_path, "w", encoding="utf-8") as f:
            for i, page in enumerate(tqdm(pages, desc="OCR Progress"), 1):
                try:
                    text = pytesseract.image_to_string(page, lang=lang)
                except Exception as e:
                    logging.error(f"OCR failed on page {i}: {e}")
                    text = ""
                f.write(f"\n--- Page {i} ---\n{text}\n")
                f.flush()  # Optional: ensures immediate write
        logging.info(f"✅ OCR output saved: {output_path}")
    except Exception as e:
        logging.error(f"Failed to write to output file: {e}")

# ---------- Main ----------
def main():
    pdf_files = [os.path.join(input_dir, f) for f in os.listdir(input_dir) if f.lower().endswith(".pdf")]
    if not pdf_files:
        logging.warning("⚠ No PDF files found in ./input")
        return

    for pdf_file in pdf_files:
        process_pdf(pdf_file)

if __name__ == "__main__":
    main()
