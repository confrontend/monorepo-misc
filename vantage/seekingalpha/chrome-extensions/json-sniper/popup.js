const $ = (id) => document.getElementById(id);

const TOGGLES = ["replaceOnRecapture", "toast", "autoDownload", "prettyPrint"];
const DEFAULT_PATTERN = "api/v3/(ticker_changes|historical_prices)";

const DEFAULTS = {
  enabled: false,
  pattern: DEFAULT_PATTERN,
  flags: "i",
  replaceOnRecapture: true,
  toast: true,
  autoDownload: false,
  prettyPrint: true,
};

let state = { ...DEFAULTS };

function send(type) {
  return new Promise((res) => chrome.runtime.sendMessage({ type }, (r) => res(r || {})));
}

function note(text) {
  $("note").textContent = text;
  clearTimeout(note._t);
  note._t = setTimeout(() => ($("note").textContent = ""), 3000);
}

function validate() {
  const p = $("pattern").value;
  const hint = $("hint");
  if (!p) {
    hint.textContent = "Matched against the full response URL.";
    hint.classList.remove("bad");
    return false;
  }
  try {
    new RegExp(p, $("flags").value);
    hint.textContent = "Matched against the full response URL.";
    hint.classList.remove("bad");
    return true;
  } catch (e) {
    hint.textContent = e.message.replace(/^Invalid regular expression: /, "");
    hint.classList.add("bad");
    return false;
  }
}

function renderStatus() {
  const live = state.enabled && !!state.pattern;
  $("status").dataset.live = String(live);
  $("stateText").textContent = live ? "Capturing" : state.enabled ? "Set a pattern" : "Idle";
  $("toggle").textContent = state.enabled ? "Stop" : "Start capture";
  $("toggle").setAttribute("aria-pressed", String(state.enabled));
  $("prettyPrint").disabled = !state.autoDownload;
}

function renderStats(s) {
  if (!s || s.error) return;
  $("rowCount").textContent = (s.rowCount || 0).toLocaleString();
  $("tickerCount").textContent = s.tickerCount || 0;
  $("keyCount").textContent = s.keyCount || 0;

  const items = s.recent || [];
  $("empty").hidden = items.length > 0;
  $("list").replaceChildren(
    ...items.map((r) => {
      const li = document.createElement("li");

      const row = document.createElement("div");
      row.className = "row";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r._key;

      const count = document.createElement("span");
      count.className = "code";
      count.textContent = r.count + " rows";

      const time = document.createElement("span");
      time.className = "time";
      time.textContent = new Date(r._ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      row.append(name, count, time);

      const path = document.createElement("div");
      path.className = "path";
      path.title = r.url || "";
      path.textContent = (r.url || "").replace(/^https?:\/\//, "");

      li.append(row, path);
      return li;
    })
  );
}

async function save(patch) {
  Object.assign(state, patch);
  await chrome.storage.local.set(patch);
}

async function refresh() {
  renderStats(await send("stats"));
}

async function init() {
  state = await chrome.storage.local.get(DEFAULTS);

  $("pattern").value = state.pattern || "";
  $("flags").value = state.flags || "i";
  for (const k of TOGGLES) $(k).checked = !!state[k];

  validate();
  renderStatus();
  refresh();

  $("toggle").addEventListener("click", async () => {
    await save({ enabled: !state.enabled });
    renderStatus();
  });

  const commit = async () => {
    const ok = validate();
    await save({ pattern: ok ? $("pattern").value : "", flags: $("flags").value || "i" });
    renderStatus();
  };
  $("pattern").addEventListener("input", commit);
  $("flags").addEventListener("input", commit);

  for (const k of TOGGLES) {
    $(k).addEventListener("change", async () => {
      await save({ [k]: $(k).checked });
      renderStatus();
    });
  }

  $("exportCsv").addEventListener("click", async () => {
    const r = await send("exportCsv");
    note(r.error ? r.error : `Wrote ${r.kinds || 0} CSV file(s) to Downloads/json-sniper`);
  });
  $("exportJson").addEventListener("click", async () => {
    const r = await send("exportJson");
    note(r.error ? r.error : `${(r.rows || 0).toLocaleString()} rows queued`);
  });
  $("exportRaw").addEventListener("click", async () => {
    const r = await send("exportRaw");
    note(r.error ? r.error : `${r.payloads || 0} raw payloads queued`);
  });
  $("clear").addEventListener("click", async () => {
    await send("clear");
    await refresh();
    note("Database emptied");
  });

  setInterval(refresh, 2000); // popup is short-lived; cheap enough
}

init();
