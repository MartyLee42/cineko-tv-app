// Links to Songsterr that open its mobile app when it is installed.
//
// Verified on songsterr.com/.well-known (2026-11):
// - assetlinks.json: Android package com.songsterr, handle_all_urls (App Links);
// - apple-app-site-association: applinks for every path (Universal Links).
// iOS needs nothing special: a user tap on a plain cross-domain <a href> opens the app
// (not window.open from JS — so render it as a real link). Android Chrome rarely hands a
// web link to an app, so there we use an intent:// URL pinned to the package; Chrome opens
// the web page itself (browser_fallback_url) when the app is missing.

export const SONGSTERR_ANDROID_PACKAGE = "com.songsterr";

export function isAndroid(userAgent: string): boolean {
  return /\bAndroid\b/i.test(userAgent);
}

/** href for a songsterr.com URL: an app intent on Android, the URL itself elsewhere. */
export function songsterrLink(url: string, userAgent: string): string {
  if (!isAndroid(userAgent)) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "https:" || !/(^|\.)songsterr\.com$/i.test(u.hostname)) return url;
  return (
    `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=${SONGSTERR_ANDROID_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(u.href)};end`
  );
}
