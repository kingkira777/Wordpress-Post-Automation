import { extractFromHtml } from "@extractus/article-extractor";
import dotenv from "dotenv";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

dotenv.config();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function urlError(message) {
  const err = new Error(message);
  err.badUrl = true;
  return err;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`Missing ${name}. Copy .env.example to .env and fill it.`);
  }
  return value;
}

function dateOnly(value) {
  const raw = value?.trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return "";
    }
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(parsed);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripLinks(html) {
  const unwrapped = html.replace(/<a\b[^>]*>/gi, "").replace(/<\/a>/gi, "");
  return unwrapped.replace(/(^|[\s>(])((?:https?:\/\/|www\.)[^\s<]+)/gi, "$1");
}

const AD_WORD =
  "advertisements?|adverts?|sponsored(?:\\s+content)?|promoted(?:\\s+content)?|paid\\s+(?:post|content)|ads?";
const INLINE_AD = new RegExp(
  [
    `[-–—*_=~]{1,3}\\s*(?:${AD_WORD})\\s*[-–—*_=~]{1,3}`,
    `[-–—*_=~]{1,3}\\s*(?:${AD_WORD})\\b`,
    `\\b(?:${AD_WORD})\\s*[-–—*_=~]{1,3}`,
    `[\\[(]\\s*(?:${AD_WORD})\\s*[\\])]`,
  ].join("|"),
  "gi",
);
const AD_LABEL = new RegExp(`^(?:${AD_WORD})$`, "i");
const BLOCK_TAG = "p|div|span|h[1-6]|aside|figure|figcaption|li|section|blockquote";

function visibleText(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAdLabel(text) {
  const core = text.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return AD_LABEL.test(core);
}

function stripAds(html) {
  let out = html.replace(INLINE_AD, "");
  const leaf = new RegExp(
    `<(${BLOCK_TAG})\\b[^>]*>(?:(?!<\\/?(?:${BLOCK_TAG})\\b)[\\s\\S])*?<\\/\\1>`,
    "gi",
  );
  for (let pass = 0; pass < 6; pass += 1) {
    const next = out.replace(leaf, (match) => {
      const text = visibleText(match);
      if (!text || isAdLabel(text)) return "";
      return match;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

const PAGE_HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0",
};

function decodeHtml(buffer, contentType) {
  const head = buffer.subarray(0, 8192).toString("latin1");
  const fromHeader = /charset=([^;]+)/i.exec(contentType || "")?.[1];
  const fromMeta =
    /<meta[^>]+charset=["']?\s*([^"'>\s/]+)/i.exec(head)?.[1] ||
    /<meta[^>]+content=["'][^"']*charset=([^"'>\s;]+)/i.exec(head)?.[1];
  let charset = (fromHeader || fromMeta || "utf-8").trim().toLowerCase().replace(/['"]/g, "");
  if (charset === "utf8") charset = "utf-8";
  if (charset === "latin1") charset = "iso-8859-1";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function readMeta(html, key) {
  const head = html.slice(0, 100000);
  const pattern = new RegExp(
    `<meta\\b[^>]*?(?:property|name)\\s*=\\s*["']${key}["'][^>]*?content\\s*=\\s*["']([^"']+)["']|<meta\\b[^>]*?content\\s*=\\s*["']([^"']+)["'][^>]*?(?:property|name)\\s*=\\s*["']${key}["']`,
    "i",
  );
  const match = pattern.exec(head);
  return decodeEntities((match?.[1] || match?.[2] || "").replace(/\s+/g, " ").trim());
}

function siteLabel(html, pageUrl) {
  const name = readMeta(html, "og:site_name") || readMeta(html, "application-name");
  if (name && !/^https?:\/\//i.test(name)) return name;
  return pageUrl.hostname.replace(/^www\./i, "");
}

function textLength(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().length;
}

function embeddedArticles(html) {
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const found = [];
  const seen = new Set();
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (typeof node.body_html === "string" && node.body_html.length > 200 && !seen.has(node.body_html)) {
      seen.add(node.body_html);
      found.push(node);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return found;
}

function applyEmbeddedArticle(article, html) {
  const candidates = embeddedArticles(html);
  if (!candidates.length) return article;
  candidates.sort((a, b) => textLength(b.body_html) - textLength(a.body_html));
  const best = candidates[0];
  const embeddedLen = textLength(best.body_html);
  const extractedLen = textLength(article?.content || "");
  if (embeddedLen < 200 || extractedLen >= embeddedLen * 0.8) return article;
  const author = best.authors?.find((item) => item?.name)?.name;
  return {
    ...article,
    title: best.headline || article?.title,
    content: best.body_html,
    description: best.description_text || article?.description,
    author: author || article?.author,
    published: best.firstpublished || article?.published,
  };
}

async function loadArticle(url) {
  const res = await fetch(url, { headers: PAGE_HEADERS, redirect: "follow" });
  if (!res.ok) throw urlError(`Article fetch failed (${res.status}) ${url}`);
  const html = decodeHtml(Buffer.from(await res.arrayBuffer()), res.headers.get("content-type"));
  if (!html.trim()) throw urlError(`Empty page: ${url}`);
  const article = applyEmbeddedArticle(await extractFromHtml(html, res.url || url), html);
  return { html, article, finalUrl: res.url || url };
}

function firstImgSrc(html) {
  if (!html) return null;
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

function leadImage(article, pageUrl) {
  const raw = article.image || firstImgSrc(article.content);
  if (!raw) return null;
  try {
    return new URL(raw, pageUrl).href;
  } catch {
    return null;
  }
}

function extensionFor(contentType) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
  };
  return map[type] ?? "";
}

function filenameFrom(imageUrl, contentType) {
  let name = "lead-image";
  try {
    const base = basename(new URL(imageUrl).pathname);
    if (base) name = base;
  } catch {
    // Keep the default name when the URL has no path.
  }
  name = name.replace(/[^\w.\-]+/g, "_");
  if (!/\.[a-z0-9]+$/i.test(name)) {
    name += extensionFor(contentType);
  }
  return name || "lead-image";
}

function wpError(body, statusText) {
  if (typeof body?.message === "string" && body.message) return body.message;
  if (statusText) return statusText;
  return "Unknown WordPress error";
}

function readUrlList(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") fail(`URL file not found: ${filePath}`);
    throw err;
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const entries = [];
  lines.forEach((line, index) => {
    const url = line.trim();
    if (!url || url.startsWith("#")) return;
    entries.push({ url, index });
  });
  if (entries.length === 0) fail(`No URLs in ${filePath}. Add one article URL per line.`);
  return { lines, entries, newline, trailingNewline: text.endsWith("\n"), dirty: false };
}

function flagBadUrl(list, entry, message) {
  const reason = message.replace(/\s+/g, " ").trim();
  list.lines[entry.index] = `# BAD ${entry.url} — ${reason}`;
  list.dirty = true;
}

function saveUrlList(filePath, list) {
  if (!list.dirty) return;
  let text = list.lines.join(list.newline);
  if (list.trailingNewline) text += list.newline;
  writeFileSync(filePath, text);
}

const listPath = process.argv[2] || "urls.txt";
if (/^https?:\/\//i.test(listPath)) {
  fail("Put each article URL in urls.txt, one per line. Then run: node draft.js");
}

const urlList = readUrlList(listPath);
const wpUrl = requireEnv("WP_URL").replace(/\/+$/, "");
const wpUser = requireEnv("WP_USER");
const wpPassword = requireEnv("WP_APP_PASSWORD").replace(/\s+/g, "");
const auth = `Basic ${Buffer.from(`${wpUser}:${wpPassword}`).toString("base64")}`;

async function uploadMedia(imageUrl) {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    throw new Error(`Image download failed (${imageRes.status}) ${imageUrl}`);
  }

  const contentType = imageRes.headers.get("content-type") || "application/octet-stream";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Lead URL is not an image (${contentType})`);
  }

  const bytes = Buffer.from(await imageRes.arrayBuffer());
  const filename = filenameFrom(imageUrl, contentType);
  const mediaType = contentType.split(";")[0].trim();
  const mediaRes = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": mediaType,
    },
    body: bytes,
  });
  const body = await mediaRes.json().catch(() => ({}));
  if (!mediaRes.ok) {
    throw new Error(`Media upload failed (${mediaRes.status}): ${wpError(body, mediaRes.statusText)}`);
  }
  if (!body.id) {
    throw new Error("Media upload returned no id");
  }
  return body.id;
}

async function draftOne(articleArg) {
  let pageUrl;
  try {
    pageUrl = new URL(articleArg);
  } catch {
    throw urlError(`Invalid article URL: ${articleArg}`);
  }

  const loaded = await loadArticle(pageUrl.href);
  if (loaded.finalUrl) {
    try {
      pageUrl = new URL(loaded.finalUrl);
    } catch {
      // Keep the URL from the file when the redirect target is invalid.
    }
  }
  const article = loaded.article;
  if (!article?.title || !article?.content) {
    throw urlError(`Could not extract an article from ${pageUrl.href}`);
  }

  let featuredMedia;
  const imageUrl = leadImage(article, pageUrl.href);
  if (imageUrl) {
    try {
      featuredMedia = await uploadMedia(imageUrl);
    } catch (err) {
      console.error(`Image skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  const author = article.author?.trim() || "";
  const published = dateOnly(article.published);
  if (!author) console.error("Author not found.");
  if (!published) console.error("Published date not found.");

  const sourceUrl = escapeHtml(pageUrl.href);
  const sourceName = escapeHtml(siteLabel(loaded.html, pageUrl));
  let byline = "";
  if (author && published) byline = `<p>By: ${escapeHtml(author)} | ${escapeHtml(published)}</p>\n`;
  else if (author) byline = `<p>By: ${escapeHtml(author)}</p>\n`;
  else if (published) byline = `<p>${escapeHtml(published)}</p>\n`;
  const post = {
    title: article.title,
    content: `${byline}${stripLinks(stripAds(article.content))}\n<p>Source: <a href="${sourceUrl}">${sourceName}</a></p>`,
    status: "draft",
  };
  if (article.description) post.excerpt = article.description;
  if (featuredMedia) post.featured_media = featuredMedia;

  const postRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(post),
  });
  const created = await postRes.json().catch(() => ({}));
  if (!postRes.ok) {
    throw new Error(`Draft failed (${postRes.status}): ${wpError(created, postRes.statusText)}`);
  }

  console.log(pageUrl.href);
  console.log(`Draft ${created.id}`);
  console.log(`${wpUrl}/wp-admin/post.php?post=${created.id}&action=edit`);
}

let failed = 0;
for (const entry of urlList.entries) {
  try {
    await draftOne(entry.url);
  } catch (err) {
    failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    if (err?.badUrl) {
      console.error(`BAD ${entry.url}`);
      console.error(message);
      flagBadUrl(urlList, entry, message);
    } else {
      console.error(`FAIL ${entry.url}`);
      console.error(message);
    }
  }
}
saveUrlList(listPath, urlList);
if (failed) fail(`${failed} of ${urlList.entries.length} drafts failed`);
