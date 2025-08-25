// Runtime: Node.js 20.x (Lambda)
// Env vars required:
//   OPENAI_API_KEY
//   LINE_CHANNEL_ACCESS_TOKEN
//   LINE_USER_ID  // or LINE_GROUP_ID / LINE_ROOM_ID if you push to a group/room
//
// npm deps in package.json:
// {
//   "name": "stock-news-digest",
//   "type": "module",
//   "version": "1.0.0",
//   "dependencies": {
//     "fast-xml-parser": "^4.4.1",
//     "openai": "^4.56.0"
//   }
// }

import { XMLParser } from "fast-xml-parser";
import OpenAI from "openai";

const TICKERS = [
  { sym: "AMZN", q: "Amazon.com Inc" },
  { sym: "GOOGL", q: "Alphabet Inc Google" },
  { sym: "NVDA", q: "NVIDIA Corporation" },
  { sym: "NET", q: "Cloudflare Inc" },
  { sym: "INTC", q: "Intel Corporation" },
  { sym: "MSFT", q: "Microsoft Corporation" },
  { sym: "AMD", q: "Advanced Micro Devices" },
];

const newsFeedUrl = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(
    q
  )}&hl=en-US&gl=US&ceid=US:en`;

async function fetchRss(url, maxItems = 8) {
  const res = await fetch(url, { timeout: 10_000 });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const j = parser.parse(xml);
  const items = j?.rss?.channel?.item || [];
  return items.slice(0, maxItems).map((it) => ({
    title: (it.title || "").trim(),
    url: (it.link || "").trim(),
    date: (it.pubDate || it["dc:date"] || "").toString().slice(0, 16), // short
  }));
}

// simple near-dup by normalized title
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.title
      .toLowerCase()
      .replace(/[-–—|·•]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\b(?:the|a|an|and|for|with|of|to|from|by)\b/g, "")
      .trim();
    if (!seen.has(key) && it.title && it.url) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

// compact, line-based input (saves tokens)
function buildCompactUserInput(map) {
  const lines = [];
  for (const [sym, items] of Object.entries(map)) {
    lines.push(sym);
    for (const it of items.slice(0, 4)) {
      lines.push(`- ${it.date} | ${it.title} | ${it.url}`);
    }
  }
  return lines.join("\n");
}

async function summarize(allTickers) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const system = "Return concise stock-moving bullets. No preamble.";
  const user = [
    "Summarize headlines per ticker.",
    "For each ticker: 3 bullets max; ≤40 words each bullet.",
    "Focus: earnings, guidance, deals, regulation, litigation, product/AI, execs, macro.",
    "Cite with [n] linking to the URL in that bullet.",
    "Format exactly:",
    "",
    "TICKER",
    "• bullet text [1]",
    "• bullet text [2]",
    "• bullet text [3]",
    "",
    "HEADLINES:",
    buildCompactUserInput(allTickers),
  ].join("\n");

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.1,
    max_tokens: 240, // hard cap
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return resp.choices[0].message.content;
}

// -------- LINE Messaging API (push) -----------
async function linePushText(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("Missing LINE_CHANNEL_ACCESS_TOKEN");

  // LINE text message limit is large (~5000 chars). We’ll chunk to be safe.
  const chunks = chunkText(text, 1200); // conservative split

  const to =
    process.env.LINE_USER_ID ||
    process.env.LINE_GROUP_ID ||
    process.env.LINE_ROOM_ID;

  if (!to)
    throw new Error("Missing LINE_USER_ID (or LINE_GROUP_ID/LINE_ROOM_ID)");

  const isGroup = !!process.env.LINE_GROUP_ID;
  const isRoom = !!process.env.LINE_ROOM_ID;

  // Push uses /v2/bot/message/push with { to, messages }
  // (to = userId OR groupId OR roomId)
  for (const c of chunks) {
    const body = {
      to,
      messages: [{ type: "text", text: c }],
    };
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`LINE push failed ${res.status}: ${msg}`);
    }
  }
}

function chunkText(s, maxLen) {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    parts.push(s.slice(i, i + maxLen));
    i += maxLen;
  }
  return parts;
}
// ---------------------------------------------

export const handler = async () => {
  // 1) fetch & trim headlines
  const news = {};
  for (const { sym, q } of TICKERS) {
    const raw = await fetchRss(newsFeedUrl(q), 8);
    news[sym] = dedupe(raw).slice(0, 4);
  }

  // 2) summarize (token-lean)
  const digest = await summarize(news);

  // 3) send to LINE
  const tz = "Asia/Bangkok";
  const now = new Date().toLocaleString("en-GB", { timeZone: tz });
  const header = `Daily Stock News Digest — ${now} (${tz})\n`;
  await linePushText(header + digest);

  return { ok: true };
};
