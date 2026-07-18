const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const inputDir = process.argv[2] || "./html";
const outputFile = process.argv[3] || "./messages.json";

function cleanText($, el) {
  if (!el || !el.length) return null;

  const clone = el.clone();
  clone.find("br").replaceWith("\n");

  return clone
    .text()
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim() || null;
}

function parseDate(title) {
  // Example: 03.02.2025 21:10:20 UTC-08:00
  const m = title?.match(
    /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2}) UTC([+-]\d{2}:\d{2})$/
  );

  if (!m) return null;

  const [, dd, mm, yyyy, hh, min, ss, offset] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${offset}`;
}

function messageNumber(filename) {
  const m = filename.match(/messages(\d*)\.html$/);
  return m && m[1] ? Number(m[1]) : 0;
}

function parseFile(filePath, state) {
  const html = fs.readFileSync(filePath, "utf8");
  const $ = cheerio.load(html);

  const messages = [];

  $(".message").each((_, msgEl) => {
    const msg = $(msgEl);
    const idRaw = msg.attr("id") || "";
    const idMatch = idRaw.match(/message-?(\d+)/);
    if (!idMatch) return;

    // Service date separators, e.g. "3 February 2025"
    if (msg.hasClass("service")) {
      state.currentDay = cleanText($, msg.find(".body.details").first());
      return;
    }

    const body = msg.children(".body").first();

    const from = cleanText($, body.children(".from_name").first()) || state.lastFrom;
    if (from) state.lastFrom = from;

    const dateEl = body.children(".date").first();
    const dateTitle = dateEl.attr("title") || null;

    const replyHref = body.find("> .reply_to a").attr("href") || null;
    const replyToMatch = replyHref?.match(/go_to_message(\d+)/);

    const text = cleanText($, body.children(".text").first());

    const media = body.find("> .media_wrap .media").map((_, mediaEl) => {
      const mediaNode = $(mediaEl);
      return {
        type: cleanText($, mediaNode.find(".title.bold").first()),
        description: cleanText($, mediaNode.find(".description").first()),
        status: cleanText($, mediaNode.find(".status.details").first())
      };
    }).get();

    const reactions = body.find("> .reactions .reaction").map((_, reactionEl) => {
      const reaction = $(reactionEl);
      return {
        emoji: cleanText($, reaction.find(".emoji").first()),
        users: reaction.find(".initials[title]").map((_, u) => $(u).attr("title")).get()
      };
    }).get();

    messages.push({
      id: Number(idMatch[1]),
      sourceFile: path.basename(filePath),
      day: state.currentDay,
      datetime: parseDate(dateTitle),
      datetimeRaw: dateTitle,
      from,
      text,
      replyTo: replyToMatch ? Number(replyToMatch[1]) : null,
      media,
      reactions
    });
  });

  return messages;
}

const files = fs.readdirSync(inputDir)
  .filter(f => f.endsWith(".html"))
  .sort((a, b) => messageNumber(a) - messageNumber(b));

const state = {
  currentDay: null,
  lastFrom: null
};

const allMessages = files.flatMap(file =>
  parseFile(path.join(inputDir, file), state)
);

const result = {
  exportedAt: new Date().toISOString(),
  sourceFolder: path.resolve(inputDir),
  files,
  count: allMessages.length,
  messages: allMessages
};

fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), "utf8");

console.log(`Done. Parsed ${allMessages.length} messages into ${outputFile}`);