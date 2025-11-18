import os
import logging
from pdf2image import convert_from_path, pdfinfo_from_path
import pytesseract
from tqdm import tqdm
from ebooklib import epub

# ---------- Configuration ----------
lang = 'eng'
input_dir = "./input"
output_dir = "./output"
os.makedirs(output_dir, exist_ok=True)

# ---------- Logging ----------
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ---------- Convert PDF to images ----------
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

# ---------- OCR ----------
def process_pdf(pdf_path):
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    output_txt_path = os.path.join(output_dir, f"{base_name}.txt")
    output_epub_path = os.path.join(output_dir, f"{base_name}.epub")

    pages = convert_pdf_to_images(pdf_path)
    if not pages:
        return

    logging.info(f"🔎 OCR started for: {os.path.basename(pdf_path)}")
    full_text = ""

    try:
        with open(output_txt_path, "w", encoding="utf-8") as f:
            for i, page in enumerate(tqdm(pages, desc="OCR Progress"), 1):
                try:
                    text = pytesseract.image_to_string(page, lang=lang)
                except Exception as e:
                    logging.error(f"OCR failed on page {i}: {e}")
                    text = ""

                # Add simple page number reference
                tagged_text = f"[Page {i}]\n{text.strip()}\n\n"
                f.write(tagged_text)
                f.flush()

                full_text += tagged_text

        logging.info(f"✅ Text file saved: {output_txt_path}")

        # ----- Create EPUB -----
        book = epub.EpubBook()
        book.set_title(base_name)
        book.set_language("fa")
        book.add_author("OCR Extracted")

        # Single flowing chapter for EPUB
        chapter = epub.EpubHtml(title="Full Text", file_name="full_text.xhtml", lang="fa")
        chapter.content = f"<pre>{full_text.strip()}</pre>"
        book.add_item(chapter)

        book.toc = (chapter,)
        book.spine = ['nav', chapter]
        book.add_item(epub.EpubNcx())
        book.add_item(epub.EpubNav())

        epub.write_epub(output_epub_path, book)
        logging.info(f"✅ EPUB file saved: {output_epub_path}")

    except Exception as e:
        logging.error(f"Failed during OCR or output writing: {e}")
    base_name = os.path.splitext(os.path.basename(pdf_path))[0]
    output_txt_path = os.path.join(output_dir, f"{base_name}.txt")
    output_epub_path = os.path.join(output_dir, f"{base_name}.epub")

    pages = convert_pdf_to_images(pdf_path)
    if not pages:
        return

    logging.info(f"🔎 OCR started for: {os.path.basename(pdf_path)}")
    all_text = []
    epub_chapters = []

    try:
        with open(output_txt_path, "w", encoding="utf-8") as f:
            for i, page in enumerate(tqdm(pages, desc="OCR Progress"), 1):
                try:
                    text = pytesseract.image_to_string(page, lang=lang)
                except Exception as e:
                    logging.error(f"OCR failed on page {i}: {e}")
                    text = ""

                # Write to .txt
                f.write(f"\n--- Page {i} ---\n{text}\n")
                f.flush()

                # Store for post-processing
                all_text.append((i, text))

                # Create chapter for EPUB
                chapter = epub.EpubHtml(title=f"Page {i}", file_name=f"page_{i}.xhtml", lang="fa")
                chapter.content = f"<h2>Page {i}</h2><pre>{text}</pre>"
                epub_chapters.append(chapter)

        logging.info(f"✅ Text file saved: {output_txt_path}")

        # ----- Create EPUB -----
        book = epub.EpubBook()
        book.set_title(base_name)
        book.set_language("fa")
        book.add_author("OCR Extracted")

        for chapter in epub_chapters:
            book.add_item(chapter)

        book.toc = tuple(epub_chapters)
        book.spine = ['nav'] + epub_chapters
        book.add_item(epub.EpubNcx())
        book.add_item(epub.EpubNav())

        epub.write_epub(output_epub_path, book)
        logging.info(f"✅ EPUB file saved: {output_epub_path}")

    except Exception as e:
        logging.error(f"Failed during OCR or output writing: {e}")

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
