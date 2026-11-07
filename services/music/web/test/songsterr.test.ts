import assert from "node:assert/strict";
import { test } from "node:test";
import { songsterrLink } from "../src/songsterr.ts";

const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SEARCH = "https://www.songsterr.com/?pattern=Metallica%20One";

test("android gets an intent pinned to the Songsterr app with a web fallback", () => {
  assert.equal(
    songsterrLink(SEARCH, ANDROID),
    "intent://www.songsterr.com/?pattern=Metallica%20One#Intent;scheme=https;package=com.songsterr;" +
      "S.browser_fallback_url=https%3A%2F%2Fwww.songsterr.com%2F%3Fpattern%3DMetallica%2520One;end",
  );
});

test("tab pages keep their path", () => {
  assert.match(
    songsterrLink("https://www.songsterr.com/a/wsa/metallica-one-tab-s27", ANDROID),
    /^intent:\/\/www\.songsterr\.com\/a\/wsa\/metallica-one-tab-s27#Intent;/,
  );
});

test("iOS and desktop get the plain URL (Universal Links handle iOS)", () => {
  assert.equal(songsterrLink(SEARCH, IPHONE), SEARCH);
  assert.equal(songsterrLink(SEARCH, DESKTOP), SEARCH);
  assert.equal(songsterrLink(SEARCH, ""), SEARCH);
});

test("non-Songsterr or broken URLs are left alone", () => {
  assert.equal(songsterrLink("https://www.ultimate-guitar.com/x", ANDROID), "https://www.ultimate-guitar.com/x");
  assert.equal(songsterrLink("https://evilsongsterr.com/x", ANDROID), "https://evilsongsterr.com/x");
  assert.equal(songsterrLink("not a url", ANDROID), "not a url");
});
