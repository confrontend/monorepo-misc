import os
import logging
from tqdm import tqdm
from pdf2image import convert_from_path, pdfinfo_from_path
import easyocr
import shutil

# ---------- Configuration ----------
PDF_PATH = "2file.pdf"
OUTPUT_PATH = "output_persian.txt"
TEMP_IMAGE_DIR = "temp_images"
LANGUAGES = ['fa']  # Persian
DPI = 300

# ---------- Logging ----------
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def setup_temp_dir():
    if os.path.exists(TEMP_IMAGE_DIR):
        shutil.rmtree(TEMP_IMAGE_DIR)
    os.makedirs(TEMP_IMAGE_DIR)

def convert_pdf_to_images(path, dpi):
    try:
        logging.info("Getting PDF info...")
        info = pdfinfo_from_path(path)
        total_pages = info.get("Pages", 0)

        logging.info(f"Converting {total_pages} pages to images...")
        image_paths = []

        for i in tqdm(range(1, total_pages + 1), desc="Converting PDF"):
            image = convert_from_path(path, dpi=dpi, first_page=i, last_page=i)[0]
            img_path = os.path.join(TEMP_IMAGE_DIR, f"page_{i}.png")
            image.save(img_path)
            image_paths.append((i, img_path))

        return image_paths
    except Exception as e:
        logging.error("Failed during PDF to image conversion.")
        logging.error(str(e))
        return []

def cleanup_temp_images():
    if os.path.exists(TEMP_IMAGE_DIR):
        shutil.rmtree(TEMP_IMAGE_DIR)

def main():
    setup_temp_dir()
    image_paths = convert_pdf_to_images(PDF_PATH, DPI)
    if not image_paths:
        return

    logging.info("Initializing GPU OCR reader...")
    reader = easyocr.Reader(LANGUAGES, gpu=True)

    logging.info("Running OCR (sequential, GPU)...")
    results = []
    for index, path in tqdm(image_paths, desc="OCR Progress"):
        try:
            result = reader.readtext(path, detail=0, paragraph=False)
            text = "\n".join(result)
            results.append((index, text))
        except Exception as e:
            logging.error(f"OCR failed on page {index}: {e}")
            results.append((index, ""))

    try:
        with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
            for i, text in sorted(results):
                f.write(f"\n--- Page {i} ---\n{text}\n")
        logging.info("OCR completed. Output written to file.")
    finally:
        cleanup_temp_images()

if __name__ == "__main__":
    main()
