import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../bridge.js", import.meta.url), "utf8");

test("buffers an early response until settings finish loading", () => {
  let storageCallback;
  let messageHandler;
  const sent = [];
  const context = vm.createContext({
    chrome: {
      storage: {
        local: { get: (_keys, callback) => { storageCallback = callback; } },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        sendMessage: (message, callback) => { sent.push(message); callback(); },
        lastError: null,
        onMessage: { addListener: () => {} },
      },
    },
    window: {
      location: { href: "https://example.test/page" },
      addEventListener: (_name, handler) => { messageHandler = handler; },
    },
    location: { href: "https://example.test/page" },
  });

  vm.runInContext(source, context);
  messageHandler({
    source: context.window,
    data: {
      __jsonSniper: 1,
      payload: { url: "https://example.test/api/prices?slug=bma", body: "{\"data\":[]}" },
    },
  });
  assert.equal(sent.length, 0);

  storageCallback({ enabled: true, pattern: "/api/prices", flags: "i" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "capture");
  assert.equal(sent[0].data.url, "https://example.test/api/prices?slug=bma");
});
