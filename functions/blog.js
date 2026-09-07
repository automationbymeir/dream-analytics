// functions/blog.js - Opinly-powered blog (SSR) for dream-analytics.com
// Fetches published posts from the Opinly headless CMS REST API
// (https://sdk.opinly.ai/v1, see https://opinly.ai/docs/reference/rest-api)
// and renders SEO-friendly blog pages server-side.
//
// Config (functions/.env, never committed):
//   OPINLY_API_KEY       - company-scoped sk- key from Opinly dashboard > Settings > Developers
//   OPINLY_CDN_NAMESPACE - company CDN namespace (image host prefix)

const { onRequest } = require("firebase-functions/v2/https");

const OPINLY_API = "https://sdk.opinly.ai/v1";
const SITE = "https://www.dream-analytics.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();
function cached(key, ttl, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
  return produce().then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

async function opinlyFetch(path) {
  const key = process.env.OPINLY_API_KEY;
  if (!key) return { __nokey: true };
  const res = await fetch(`${OPINLY_API}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Opinly API ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function imageUrl(file) {
  if (!file || !file.fileKey) return null;
  if (/^https:\/\//i.test(file.fileKey)) return file.fileKey;
  const ns = process.env.OPINLY_CDN_NAMESPACE || "";
  return ns ? `https://cdn.opinly.ai/${ns}/${file.fileKey}` : null;
}

// ---- XSS hygiene: escape every CMS-sourced string; allowlist-render Tiptap JSON ----
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeUrl(u) {
  const s = String(u ?? "");
  return /^https:\/\//i.test(s) || s.startsWith("/") ? s : "";
}

function renderMarks(text, marks) {
  let out = esc(text);
  for (const m of marks || []) {
    if (m.type === "bold") out = `<strong>${out}</strong>`;
    else if (m.type === "italic") out = `<em>${out}</em>`;
    else if (m.type === "strike") out = `<s>${out}</s>`;
    else if (m.type === "code") out = `<code>${out}</code>`;
    else if (m.type === "link") {
      const href = safeUrl(m.attrs && m.attrs.href);
      out = href ? `<a href="${esc(href)}" rel="noopener">${out}</a>` : out;
    }
  }
  return out;
}

function renderNode(node) {
  if (!node || typeof node !== "object") return "";
  const kids = (node.content || []).map(renderNode).join("");
  switch (node.type) {
    case "doc": return kids;
    case "paragraph": return kids.trim() ? `<p>${kids}</p>` : "";
    case "heading": {
      const lvl = Math.min(4, Math.max(2, (node.attrs && node.attrs.level) || 2));
      return `<h${lvl}>${kids}</h${lvl}>`;
    }
    case "text": return renderMarks(node.text || "", node.marks);
    case "hardBreak": return "<br>";
    case "bulletList": return `<ul>${kids}</ul>`;
    case "orderedList": return `<ol>${kids}</ol>`;
    case "listItem": return `<li>${kids}</li>`;
    case "blockquote": return `<blockquote>${kids}</blockquote>`;
    case "codeBlock": return `<pre><code>${kids}</code></pre>`;
    case "horizontalRule": return "<hr>";
    case "image": {
      const src = safeUrl((node.attrs && node.attrs.src) || imageUrl(node.attrs) || "");
      if (!src) return "";
      const alt = esc((node.attrs && node.attrs.alt) || "");
      return `<figure><img src="${esc(src)}" alt="${alt}" loading="lazy"></figure>`;
    }
    default: return kids; // unknown containers: render children, never raw HTML
  }
}

function renderContent(tiptap) {
  try { return renderNode(tiptap); } catch { return ""; }
}


// Hebrew/RTL support: posts containing Hebrew text render right-to-left.
const HEBREW_RE = /[\u0590-\u05FF]/;
function rtlAttr(...texts) {
  return texts.some((t) => typeof t === "string" && HEBREW_RE.test(t)) ? ' dir="rtl" lang="he"' : "";
}

// ---- Page template (mirrors the static site shell) ----
function page({ title, description, canonical, ogImage, jsonLd, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="DreamCoach">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonical)}">
  ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ""}
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" type="image/svg+xml" href="/logos/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,100..700;1,100..700&display=swap" rel="stylesheet">
  ${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
  <style>
    body { font-family: 'IBM Plex Sans', Helvetica, Arial, sans-serif; background: #fafafa; margin: 0; padding: 16px; color: #1a2e2b; }
    a { color: #00695c; }
    nav { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
    nav > ul { list-style: none; display: flex; gap: 24px; flex-wrap: wrap; padding: 0; }
    nav a { color: #1a2e2b; text-decoration: none; font-weight: 500; }
    nav a:hover { color: #00897b; }
    main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
    .blog-index h1 { font-size: 2.4rem; margin-bottom: 8px; }
    .sub { color: #4a5a57; margin-bottom: 40px; }
    .cards { display: grid; gap: 24px; }
    .card { background: #ffffff; border: 1px solid #dfe7e5; border-radius: 14px; overflow: hidden; }
    .card img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; }
    .card .pad { padding: 20px 22px 24px; }
    .card h2 { margin: 0 0 8px; font-size: 1.35rem; }
    .card h2 a { color: #1a2e2b; text-decoration: none; }
    .card h2 a:hover { color: #00897b; }
    .meta { color: #7d8c89; font-size: 0.85rem; margin-bottom: 10px; }
    .card p { color: #4a5a57; margin: 0; line-height: 1.55; }
    article h1 { font-size: 2.2rem; line-height: 1.2; margin-bottom: 8px; }
    article img.hero { width: 100%; border-radius: 14px; margin: 24px 0; }
    article .content { line-height: 1.75; color: #2a3a37; font-size: 1.05rem; }
    article .content h2 { margin-top: 40px; }
    article .content h3 { margin-top: 32px; }
    article .content pre { background: #eef3f2; border: 1px solid #dfe7e5; padding: 16px; border-radius: 10px; overflow-x: auto; }
    article .content code { background: #eef3f2; padding: 2px 6px; border-radius: 6px; }
    article .content pre code { padding: 0; background: none; }
    article .content blockquote { border-inline-start: 3px solid #00897b; margin: 24px 0; padding: 4px 20px; color: #4a5a57; }
    .faq { margin-top: 48px; }
    .faq details { background: #ffffff; border: 1px solid #dfe7e5; border-radius: 10px; padding: 14px 18px; margin-bottom: 12px; }
    .faq summary { cursor: pointer; font-weight: 600; }
    .empty { color: #4a5a57; background: #ffffff; border: 1px dashed #dfe7e5; border-radius: 14px; padding: 48px 24px; text-align: center; }
  </style>
</head>
<body>
  <nav>
    <ul>
      <li><a href="/">DreamCoach</a></li>
      <li><a href="/about.html">About</a></li>
      <li><a href="/pricing.html">Pricing</a></li>
      <li><a href="/blog">Blog</a></li>
      <li><a href="/he/">עב</a></li>
    </ul>
  </nav>
  <main>${body}</main>
  
</body>
</html>`;
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
}

const EMPTY_BODY = `<div class="blog-index"><h1>Blog</h1><p class="sub">Dream interpretation guides and sleep science notes from DreamCoach.</p><div class="empty"><p>First posts are on the way. Check back soon.</p></div></div>`;

async function renderIndex() {
  const data = await cached("posts", CACHE_TTL_MS, () =>
    opinlyFetch("/content/posts?limit=24&sort=newest").catch((e) => ({ __error: e.message }))
  );
  if (!data || data.__nokey || data.__error || !Array.isArray(data.data) || data.data.length === 0) {
    return page({
      title: "Blog | DreamCoach",
      description: "Dream interpretation guides, dream science and lucid dreaming techniques.",
      canonical: `${SITE}/blog`,
      body: EMPTY_BODY,
    });
  }
  const cards = data.data.map((p) => {
    const img = imageUrl(p.titleFile);
    const dir = rtlAttr(p.title, p.description);
    return `<div class="card"${dir}>${img ? `<a href="/blog/${esc(p.slug)}"><img src="${esc(img)}" alt="${esc(p.titleFile.altText || p.title)}" loading="lazy"></a>` : ""}<div class="pad"><div class="meta">${esc(fmtDate(p.firstPublishedAt))}${p.category ? " · " + esc(p.category.name) : ""}</div><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2><p>${esc(p.description || "")}</p></div></div>`;
  }).join("");
  return page({
    title: "Blog | DreamCoach",
    description: "Dream interpretation guides, dream science and lucid dreaming techniques.",
    canonical: `${SITE}/blog`,
    body: `<div class="blog-index"><h1>Blog</h1><p class="sub">Dream interpretation guides, dream science and lucid dreaming techniques.</p><div class="cards">${cards}</div></div>`,
  });
}

async function renderPost(slug) {
  const post = await cached(`post:${slug}`, CACHE_TTL_MS, () =>
    opinlyFetch(`/content/post?slug=${encodeURIComponent(slug)}`).catch((e) => ({ __error: e.message }))
  );
  if (!post || post.__nokey || post.__error || !post.slug) return null;
  const hero = imageUrl(post.titleFile);
  const contentHtml = renderContent(post.content);
  const faq = Array.isArray(post.faqs) && post.faqs.length
    ? `<section class="faq"><h2>FAQ</h2>${post.faqs.map((f) => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`).join("")}</section>`
    : "";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.metaDescription || post.description || "",
    datePublished: post.firstPublishedAt,
    dateModified: post.modifiedAt || post.firstPublishedAt,
    author: post.author ? { "@type": "Person", name: post.author.name } : { "@type": "Organization", name: "DreamCoach" },
    image: hero || undefined,
    mainEntityOfPage: `${SITE}/blog/${post.slug}`,
  }).replace(/</g, "\\u003c");
  return page({
    title: post.metaTitle || `${post.title} | DreamCoach`,
    description: post.metaDescription || post.description || "",
    canonical: `${SITE}/blog/${post.slug}`,
    ogImage: hero,
    jsonLd,
    body: `<article${rtlAttr(post.title, post.metaDescription || post.description)}><h1>${esc(post.title)}</h1><div class="meta">${esc(fmtDate(post.firstPublishedAt))}${post.author ? " · " + esc(post.author.name) : ""}${post.category ? " · " + esc(post.category.name) : ""}</div>${hero ? `<img class="hero" src="${esc(hero)}" alt="${esc((post.titleFile && post.titleFile.altText) || post.title)}">` : ""}<div class="content">${contentHtml}</div>${faq}</article>`,
  });
}

exports.blog = onRequest({ region: "us-central1", timeoutSeconds: 30, memory: "256MiB" }, async (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    try {
      const parts = req.path.split("/").filter(Boolean); // e.g. ["blog"] or ["blog","my-post"]
      if (parts.length === 1) {
        res.status(200).send(await renderIndex());
        return;
      }
      if (parts.length === 2) {
        const html = await renderPost(parts[1]);
        if (html) {
          res.status(200).send(html);
        } else {
          res.redirect(302, "/blog");
        }
        return;
      }
      res.redirect(302, "/blog");
    } catch (e) {
      console.error("blog render failed", e);
      res.status(200).send(page({
        title: "Blog | DreamCoach",
        description: "Dream interpretation guides and sleep science notes from DreamCoach.",
        canonical: `${SITE}/blog`,
        body: EMPTY_BODY,
      }));
    }
  });
