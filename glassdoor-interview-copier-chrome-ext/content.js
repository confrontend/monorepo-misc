console.log("Content script loaded on:", window.location.href);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Message received:", request);

  if (request.action === "getPageInfo") {
    sendResponse({
      company: document.title.match(/(.+?)\s*(?:-|\|)/)?.[1] || "glassdoor",
      title: document.title,
    });
    return;
  }

  if (request.action === "getCompany") {
    let company = document.title.match(/(.+?)\s*(?:-|\|)/)?.[1] || "glassdoor";
    company = company.replace(/[^a-z0-9]/gi, "_");
    console.log("Sending company:", company);
    sendResponse({ company });
    return;
  }
  if (request.action === "copyPage") {
    // COMPANY DETECTION (from manual test)
    let company = document.title.match(/(.+?)\s*(?:-|\|)/)?.[1] || "Glassdoor";
    console.log("Company:", company);

    // QUESTION EXTRACTION (from manual test)
    const questions = [];
    document
      .querySelectorAll(
        'div[class*="interview"], div[class*="question"], [class*="InterviewQTN"], [class*="interviewDetail"]',
      )
      .forEach((el, i) => {
        const text = el.textContent.trim();
        if (
          text.length > 50 &&
          (text.toLowerCase().includes("question") ||
            text.toLowerCase().includes("interview") ||
            text.toLowerCase().includes("design") ||
            text.toLowerCase().includes("system") ||
            text.toLowerCase().includes("experience"))
        ) {
          questions.push(`Q${i + 1}: ${text.substring(0, 300)}`);
        }
      });

    const pageContent = `${company} - ${new Date().toISOString()}\n\n${questions.slice(0, 15).join("\n\n---\n\n")}\n\n`;
    console.log(`Extracted ${questions.length} questions`);
    sendResponse({ content: pageContent });
  } else if (request.action === "nextPage") {
    console.log("Looking for NEXT page button...");

    // FIXED: More specific next button selectors
    const nextSelectors = [
      '[data-test="next-page"]',
      'a[data-test="page-link-next"]',
      ".pagination_NextButton",
      '[class*="next"][class*="page"]',
      'a[aria-label*="Next"]',
      '[class*="pagination"] a:not([class*="selected"]):not([data-test="page-number-"]):last-of-type',
      // Glassdoor specific from your log
      ".pagination_ListItemButton:not(.pagination_ButtonSelected)",
      '[data-test^="page-number-"]:not([data-test="page-number-1"]):last-of-type',
    ];

    let nextBtn = null;
    for (let sel of nextSelectors) {
      const candidates = document.querySelectorAll(sel);
      console.log(`Selector "${sel}": ${candidates.length} candidates`);

      // Find the actual NEXT (not current or prev)
      for (let btn of candidates) {
        const href = btn.getAttribute("href") || "";
        const ariaLabel = btn.getAttribute("aria-label") || "";
        const testId = btn.getAttribute("data-test") || "";

        // Skip current page and page numbers
        if (
          !testId.includes("page-number-") &&
          !btn.classList.contains("pagination_ButtonSelected") &&
          (href.includes("page=") ||
            ariaLabel.includes("Next") ||
            btn.textContent.trim().includes(">"))
        ) {
          nextBtn = btn;
          console.log("NEXT button:", sel, btn.outerHTML.substring(0, 150));
          break;
        }
      }
      if (nextBtn) break;
    }

    if (nextBtn) {
      nextBtn.click();
      console.log("Clicked next page!");
    } else {
      console.error("No valid next button found");
      // List all pagination links
      const allLinks = document.querySelectorAll(
        '.pagination a, [class*="pagination"] a',
      );
      console.log("All pagination links:", allLinks.length);
      allLinks.forEach((l, i) => console.log(i, l.outerHTML.substring(0, 100)));
    }
  }

  return true;
});
