// Minimal, dependency-free UA → {browser, os}. Not exhaustive fingerprinting —
// just enough triage context for the issue. Pure: takes the UA string.

export interface ParsedUA {
  browser: string;
  os: string;
}

export function parseUA(ua: string): ParsedUA {
  const browser = (() => {
    if (/\bEdg\//.test(ua)) return "Edge";
    if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
    if (/\bFirefox\/(\d+)/.test(ua)) return `Firefox ${RegExp.$1}`;
    if (/\bChrome\/(\d+)/.test(ua) && !/\bChromium\b/.test(ua)) return `Chrome ${RegExp.$1}`;
    // Safari has no "Chrome" and reports Version/x
    if (/\bVersion\/(\d+).*\bSafari\//.test(ua)) return `Safari ${RegExp.$1}`;
    if (/\bSafari\//.test(ua)) return "Safari";
    return "unknown";
  })();

  const os = (() => {
    if (/\bWindows NT 10/.test(ua)) return "Windows 10/11";
    if (/\bWindows NT/.test(ua)) return "Windows";
    if (/\biPhone\b|\biPad\b|\biPod\b/.test(ua)) return "iOS";
    if (/\bMac OS X\b/.test(ua)) return "macOS";
    if (/\bAndroid\b/.test(ua)) return "Android";
    if (/\bLinux\b/.test(ua)) return "Linux";
    return "unknown";
  })();

  return { browser, os };
}
