import os
import fitz  # PyMuPDF
import re

# -------- Config --------
PDF_PATH = "./input/full.pdf"
OUTPUT_DIR = "output"
os.makedirs(OUTPUT_DIR, exist_ok=True)

    
# -------- Chapter Ranges (page numbers are 1-based) --------
CHAPTERS = [
    # ("Introduction", 1, 38),
    # ("1. Income and Output", 39, 71),
    # ("2. Growth: Illusions and Realities", 72, 112),
    # ("3. The Metamorphoses of Capital", 113, 139),
    # ("4. From Old Europe to the New World", 140, 163),
    # ("5. The Capital/Income Ratio over the Long Run", 164, 198),
    # ("6. The Capital-Labor Split in the 21st Century", 199, 236),
    # ("7. Inequality and Concentration", 237, 270),
    # ("8. Two Worlds", 271, 303),
    # ("9. Inequality of Labor Income", 304, 335),
    # ("10. Inequality of Capital Ownership", 336, 376),
    # ("11. Merit and Inheritance in the Long Run", 377, 429),
    # ("12. Global Inequality of Wealth", 430, 470),
    # ("13. A Social State for the 21st Century", 471, 492),
    # ("14. Rethinking the Progressive Income Tax", 493, 514),
    # ("15. A Global Tax on Capital", 515, 539),
    # ("16. The Question of the Public Debt", 540, 570),
    # ("Conclusion", 571, 578),
]

# -------- Safe filename generator --------
def sanitize_filename(title):
    # Replace invalid characters with underscore
    return re.sub(r'[<>:"/\\|?*]', '_', title).replace(" ", "_").strip()

# -------- Extract and save plain text per chapter --------
def extract_chapters_to_txt(pdf_path, chapters):
    doc = fitz.open(pdf_path)

    for title, start, end in chapters:
        print(f"📘 Extracting: {title} (pages {start}-{end})")
        text = ""

        for page_num in range(start - 1, end):  # 0-based indexing
            page = doc.load_page(page_num)
            text += page.get_text()

        # Sanitize title for file name
        safe_title = sanitize_filename(title)
        output_path = os.path.join(OUTPUT_DIR, f"{safe_title}.txt")

        with open(output_path, "w", encoding="utf-8") as f:
            f.write(text.strip())

        print(f"✅ Saved: {output_path}")

# -------- Main --------
if __name__ == "__main__":
    extract_chapters_to_txt(PDF_PATH, CHAPTERS)