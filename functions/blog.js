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
function isHebrew(...texts) {
  return texts.some((t) => typeof t === "string" && HEBREW_RE.test(t));
}

// Chrome strings per language: Hebrew chrome shows when Hebrew posts are shown.
const UI = {
  en: {
    blog: "Blog",
    sub: "Dream interpretation guides, dream science and lucid dreaming techniques.",
    empty: "First posts are on the way. Check back soon.",
    faq: "FAQ",
    locale: "en-US",
  },
  he: {
    blog: "בלוג",
    sub: "מדריכי פירוש חלומות, מדע החלום וטכניקות חלימה צלולה.",
    empty: "הפוסטים הראשונים בדרך. בקרו שוב בקרוב.",
    faq: "שאלות נפוצות",
    locale: "he-IL",
  },
};

// ---- Page template (matches dream-analytics.com design: same Tailwind config, fonts, nav, footer) ----
const TW_CONFIG = `tailwind.config = {darkMode:"class",theme:{extend:{colors:{"secondary-container":"#dc9000","on-secondary-container":"#4f3100",surface:"#131124","on-tertiary":"#460283",outline:"#958da1","error-container":"#93000a","on-surface-variant":"#ccc3d8","outline-variant":"#4a4455",background:"#131124","surface-container-highest":"#353247",error:"#ffb4ab","surface-container":"#1f1d31","surface-container-low":"#1b192d","surface-dim":"#131124","on-secondary":"#462b00","tertiary-fixed-dim":"#dab9ff",tertiary:"#dab9ff","surface-container-high":"#2a283c","surface-tint":"#d2bbff","on-background":"#e4dffb","secondary-fixed-dim":"#ffb957","on-primary-fixed":"#25005a","inverse-on-surface":"#302e43","tertiary-container":"#804cbe","on-primary-container":"#ede0ff","on-tertiary-container":"#f1e0ff","surface-variant":"#353247","secondary-fixed":"#ffddb5","primary-fixed-dim":"#d2bbff",secondary:"#ffb957","surface-container-lowest":"#0e0c1f","primary-fixed":"#eaddff",primary:"#7C3AED","primary-container":"#7c3aed","on-error":"#690005","on-error-container":"#ffdad6","tertiary-fixed":"#eedbff","on-surface":"#e4dffb","on-primary":"#3f008e","surface-bright":"#39374c","inverse-surface":"#e4dffb","inverse-primary":"#732ee4"},borderRadius:{DEFAULT:"0.5rem",lg:"1rem",xl:"1.5rem",full:"9999px"},fontFamily:{headline:["EB Garamond","serif"],body:["Newsreader","serif"],label:["Manrope","sans-serif"],display:["EB Garamond","serif"]}}}}`;

const SITE_STYLE = `.material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  body { background-color: #131124; color: #e4dffb; }
  .glass-card { background: rgba(53,50,71,0.4); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
  .nebula-gradient { background: linear-gradient(135deg, #d2bbff 0%, #7c3aed 100%); }
  .moon-glow { box-shadow: 0 0 80px rgba(255,185,87,0.15); }
  .input-dream { background: rgba(30,22,64,0.6); border: 1px solid rgba(124,58,237,0.25); color: #e4dffb; }
  .input-dream:focus { outline: none; border-color: rgba(167,139,250,0.6); box-shadow: 0 0 15px rgba(124,58,237,0.2); }
  .input-dream::placeholder { color: rgba(204,195,216,0.35); }`;

const SITE_NAV = `<nav class="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 md:px-10 py-4 bg-[#131124]/60 backdrop-blur-xl border-b border-violet-900/20 shadow-lg">
  <a href="/" class="text-xl md:text-2xl font-headline italic text-violet-100">🌙 DreamCoach</a>
  <div class="hidden md:flex items-center gap-5">
    <a id="nav-dashboard-link" href="/dashboard.html" style="display:none" class="text-violet-300/70 font-label text-sm tracking-wide hover:text-amber-300 transition-colors">Dashboard</a>
    <a id="nav-analysis-link" href="/analysis.html" style="display:none" class="text-violet-300/70 font-label text-sm tracking-wide hover:text-amber-300 transition-colors">Analysis</a>
    <a href="/pricing.html" class="text-violet-300/70 font-label text-sm tracking-wide hover:text-amber-300 transition-colors">Pricing</a>
    <a id="nav-settings-link" href="/settings.html" style="display:none" class="text-violet-300/70 font-label text-sm tracking-wide hover:text-amber-300 transition-colors">Settings</a>
    <a id="nav-login-link" href="/login.html" class="text-violet-300/70 font-label text-sm tracking-wide hover:text-amber-300 transition-colors">Sign In</a>
    <a id="nav-logout-link" href="#" style="display:none" class="text-violet-300/70 font-label text-sm tracking-wide hover:text-amber-300 transition-colors">Sign Out</a>
  </div>
  <a id="nav-get-started" href="/login.html" class="hidden md:inline-block nebula-gradient px-6 py-2 rounded-full text-white font-label font-bold text-sm hover:scale-105 active:scale-95 transition-all shadow-lg shadow-primary/20">Get Started</a>
</nav>`;

const SITE_FOOTER = `<footer class="w-full py-10 border-t border-white/5">
      <div class="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div class="text-center md:text-left">
          <div class="text-lg font-bold text-amber-200 font-headline italic">🌙 DreamCoach Analytics</div>
          <p class="text-xs text-violet-300/40 font-label mt-1">A product of <a href="https://www.automationbymeir.com" target="_blank" class="hover:text-amber-300 transition-colors underline underline-offset-2">Automation By Meir</a></p>
        </div>
        <p class="text-xs text-violet-300/40 font-label">© 2024 DreamCoach. Navigate your subconscious.</p>
        <div class="flex flex-wrap gap-4 justify-center">
          <a href="/about.html" class="text-xs text-violet-300/50 hover:text-amber-200 transition-colors font-label">About</a>
          <a href="/support.html" class="text-xs text-violet-300/50 hover:text-amber-200 transition-colors font-label">Support</a>
          <a href="/privacy.html" class="text-xs text-violet-300/50 hover:text-amber-200 transition-colors font-label">Privacy</a>
          <a href="/terms.html" class="text-xs text-violet-300/50 hover:text-amber-200 transition-colors font-label">Terms</a>
        </div>
      </div>
    </footer>`;

const BLOG_CSS = `
    main.blog-wrap { max-width: 780px; margin: 0 auto; padding: 120px 24px 96px; min-height: 60vh; }
    .blog-index h1 { font-family: 'EB Garamond', serif; font-size: 2.8rem; color: #ede0ff; margin-bottom: 8px; }
    .sub { color: rgba(204,179,216,0.6); font-family: 'Manrope', sans-serif; font-size: 0.9rem; letter-spacing: 0.04em; margin-bottom: 40px; }
    .cards { display: grid; gap: 32px; }
    .card { border: 1px solid rgba(255,255,255,0.06); border-radius: 1.5rem; overflow: hidden; transition: border-color 0.25s; }
    .card:hover { border-color: rgba(124,58,237,0.35); }
    .card img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; }
    .card .pad { padding: 24px 26px 28px; }
    .card h2 { margin: 0 0 10px; font-family: 'EB Garamond', serif; font-size: 1.6rem; line-height: 1.25; }
    .card h2 a { color: #ede0ff; text-decoration: none; }
    .card h2 a:hover { color: #ffb957; }
    .meta { color: rgba(204,179,216,0.5); font-family: 'Manrope', sans-serif; font-size: 0.78rem; letter-spacing: 0.05em; margin-bottom: 10px; }
    .card p { color: #ccc3d8; margin: 0; line-height: 1.6; font-size: 0.95rem; }
    article h1 { font-family: 'EB Garamond', serif; font-size: 2.4rem; line-height: 1.2; color: #ede0ff; margin-bottom: 10px; }
    article img.hero { width: 100%; border-radius: 1.5rem; margin: 32px 0; box-shadow: 0 0 80px rgba(255,185,87,0.12); }
    article .content { line-height: 1.85; color: #e4dffb; font-size: 1.08rem; }
    article .content p { margin: 0 0 1.3rem; }
    article .content h2 { font-family: 'EB Garamond', serif; font-size: 1.8rem; color: #ede0ff; margin: 2.6rem 0 1rem; }
    article .content h3 { font-family: 'EB Garamond', serif; font-size: 1.4rem; color: #ede0ff; margin: 2rem 0 0.75rem; }
    article .content a { color: #ffb957; text-decoration: underline; text-underline-offset: 3px; }
    article .content ul, article .content ol { margin: 0 0 1.3rem; padding-inline-start: 1.5rem; }
    article .content li { margin-bottom: 0.5rem; }
    article .content blockquote { border-inline-start: 3px solid #7c3aed; margin: 1.6rem 0; padding: 0.4rem 1.3rem; color: #ccc3d8; font-style: italic; }
    article .content pre { background: #0e0c1f; border: 1px solid rgba(124,58,237,0.25); padding: 1rem; border-radius: 0.75rem; overflow-x: auto; }
    article .content code { background: rgba(124,58,237,0.15); padding: 2px 6px; border-radius: 6px; font-size: 0.9em; }
    article .content pre code { padding: 0; background: none; }
    article .content figure { margin: 2rem 0; }
    article .content figure img { width: 100%; border-radius: 1rem; }
    .faq { margin-top: 56px; }
    .faq h2 { font-family: 'EB Garamond', serif; color: #ede0ff; font-size: 1.8rem; margin-bottom: 18px; }
    .faq details { background: rgba(53,50,71,0.4); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.06); border-radius: 1rem; padding: 16px 20px; margin-bottom: 14px; }
    .faq summary { cursor: pointer; font-family: 'Manrope', sans-serif; font-weight: 600; color: #ede0ff; font-size: 0.95rem; }
    .faq details p { color: #ccc3d8; margin: 10px 0 0; line-height: 1.6; font-size: 0.95rem; }
    .empty { color: #ccc3d8; background: rgba(53,50,71,0.4); backdrop-filter: blur(20px); border: 1px dashed rgba(124,58,237,0.3); border-radius: 1.5rem; padding: 48px 24px; text-align: center; }
`;

function page({ title, description, canonical, ogImage, jsonLd, body, he }) {
  return `<!DOCTYPE html>
<html class="dark" lang="${he ? "he" : "en"}"${he ? ' dir="rtl"' : ""}>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}"/>
  <link rel="canonical" href="${esc(canonical)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:site_name" content="DreamCoach"/>
  <meta property="og:title" content="${esc(title)}"/>
  <meta property="og:description" content="${esc(description)}"/>
  <meta property="og:url" content="${esc(canonical)}"/>
  ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}"/>` : ""}
  <meta name="twitter:card" content="summary_large_image"/>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌙</text></svg>"/>
  <script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
  <script id="tailwind-config">${TW_CONFIG}</script>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400..800;1,400..800&family=Newsreader:opsz,wght@6..72,300;6..72,400;6..72,500&family=Manrope:wght@200..800&display=swap" rel="stylesheet"/>
  ${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
  <style>${SITE_STYLE}${BLOG_CSS}</style>
</head>
<body class="font-body selection:bg-primary/30">
${SITE_NAV}
<main class="blog-wrap">${body}</main>
${SITE_FOOTER}
</body>
</html>`;
}

function fmtDate(iso, locale) {
  try {
    return new Date(iso).toLocaleDateString(locale || "en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
}

function emptyBody(ui) {
  return `<div class="blog-index"><h1>${ui.blog}</h1><p class="sub">${ui.sub}</p><div class="empty"><p>${ui.empty}</p></div></div>`;
}

async function renderIndex() {
  const data = await cached("posts", CACHE_TTL_MS, () =>
    opinlyFetch("/content/posts?limit=24&sort=newest").catch((e) => ({ __error: e.message }))
  );
  if (!data || data.__nokey || data.__error || !Array.isArray(data.data) || data.data.length === 0) {
    return page({
      title: "Blog | DreamCoach",
      description: "Dream interpretation guides, dream science and lucid dreaming techniques.",
      canonical: `${SITE}/blog`,
      body: emptyBody(UI.en),
    });
  }
  const he = isHebrew(data.data[0].title, data.data[0].description);
  const ui = he ? UI.he : UI.en;
  const cards = data.data.map((p) => {
    const img = imageUrl(p.titleFile);
    const dir = rtlAttr(p.title, p.description);
    return `<div class="card"${dir}>${img ? `<a href="/blog/${esc(p.slug)}"><img src="${esc(img)}" alt="${esc(p.titleFile.altText || p.title)}" loading="lazy"></a>` : ""}<div class="pad"><div class="meta">${esc(fmtDate(p.firstPublishedAt, dir ? UI.he.locale : UI.en.locale))}${p.category ? " · " + esc(p.category.name) : ""}</div><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2><p>${esc(p.description || "")}</p></div></div>`;
  }).join("");
  return page({
    title: "Blog | DreamCoach",
    description: "Dream interpretation guides, dream science and lucid dreaming techniques.",
    canonical: `${SITE}/blog`,
    he,
    body: `<div class="blog-index"><h1>${ui.blog}</h1><p class="sub">${ui.sub}</p><div class="cards">${cards}</div></div>`,
  });
}

async function renderPost(slug) {
  const post = await cached(`post:${slug}`, CACHE_TTL_MS, () =>
    opinlyFetch(`/content/post?slug=${encodeURIComponent(slug)}`).catch((e) => ({ __error: e.message }))
  );
  if (!post || post.__nokey || post.__error || !post.slug) return null;
  const hero = imageUrl(post.titleFile);
  const contentHtml = renderContent(post.content);
  const he = isHebrew(post.title, post.metaDescription || post.description);
  const ui = he ? UI.he : UI.en;
  const faq = Array.isArray(post.faqs) && post.faqs.length
    ? `<section class="faq"><h2>${ui.faq}</h2>${post.faqs.map((f) => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`).join("")}</section>`
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
    he,
    body: `<article${rtlAttr(post.title, post.metaDescription || post.description)}><h1>${esc(post.title)}</h1><div class="meta">${esc(fmtDate(post.firstPublishedAt, ui.locale))}${post.author ? " · " + esc(post.author.name) : ""}${post.category ? " · " + esc(post.category.name) : ""}</div>${hero ? `<img class="hero" src="${esc(hero)}" alt="${esc((post.titleFile && post.titleFile.altText) || post.title)}">` : ""}<div class="content">${contentHtml}</div>${faq}</article>`,
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
