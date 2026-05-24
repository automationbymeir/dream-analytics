// functions/dreamVideoPipeline.js
// Twice-daily automated video generation and social posting for DreamCoach
//
// Schedule: 8:00 AM UTC and 8:00 PM UTC
// Pipeline: Gemini → Imagen 3 → Remotion Lambda → YouTube + Instagram + Facebook + Twitter
// All posts and results are logged to Firestore under `social_posts/`

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { renderMediaOnLambda, getRenderProgress } = require("@remotion/lambda/client");
const { google } = require("googleapis");
// Twitter skipped — add twitter-api-v2 and DREAM_TWITTER_* secrets when ready
const fetch = require("node-fetch");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const db = admin.firestore();

// ─── Constants ────────────────────────────────────────────────────────────────
const GCP_PROJECT            = "dreamanalysis-39322";
const FIREBASE_STORAGE_BUCKET = `${GCP_PROJECT}.firebasestorage.app`;
const IMAGEN_MODEL    = "imagen-3.0-fast-generate-001";
const VERTEX_REGION   = "us-central1";

// Remotion Lambda (same AWS account, separate DreamCoach site)
const SERVE_URL       = (process.env.DREAM_REMOTION_SERVE_URL || "").trim();
const FUNCTION_NAME   = (process.env.DREAM_REMOTION_FUNCTION_NAME || "remotion-render-4-0-452-mem3008mb-disk2048mb-900sec").trim();
const REMOTION_REGION = "us-east-1";

// YouTube OAuth
const YT_SECRET_PATH  = path.join(__dirname, "dreamcoach_yt_secret.json");
const YT_TOKEN_PATH   = path.join(__dirname, "dreamcoach_yt_tokens.json");

// Instagram / Facebook (Meta Graph API)
const IG_USER_ID      = () => process.env.DREAM_IG_USER_ID || "";
const IG_TOKEN        = () => process.env.DREAM_IG_ACCESS_TOKEN || "";
const FB_PAGE_ID      = () => process.env.DREAM_FB_PAGE_ID || "";
const FB_TOKEN        = () => process.env.DREAM_FB_ACCESS_TOKEN || "";

// Twitter / X — skipped for now

// ─── Dream fact bank (fallback when Gemini is unavailable) ───────────────────
const FALLBACK_FACTS = [
  "You forget 90% of your dreams within 10 minutes of waking. A dream journal changes everything.",
  "The average person has 3–6 dreams per night — but most are forgotten by morning.",
  "Blind people dream too. Those blind from birth experience vivid auditory, tactile, and olfactory dreams.",
  "Lucid dreaming — knowing you're dreaming while asleep — can be trained with practice.",
  "During REM sleep your body is temporarily paralysed to prevent you from acting out your dreams.",
  "Dreams may help consolidate memories: the brain replays events to move them to long-term storage.",
  "Recurring dreams often point to unresolved emotions or anxiety worth exploring.",
  "Some of history's greatest inventions came in dreams: the periodic table, the sewing machine needle, even Frankenstein.",
  "Animals dream too — dogs, cats and rats all show REM sleep brain patterns similar to humans.",
  "Negative emotions like anxiety appear in dreams more often than positive ones.",
];

// ─── Helper: get Vertex AI access token ──────────────────────────────────────
async function getVertexToken() {
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

// ─── Generate dream fact with Gemini ─────────────────────────────────────────
async function generateDreamFact(vertexApiKey, videoType) {
  const prompts = {
    fact: `Generate one fascinating, scientifically accurate dream fact that most people don't know.
Make it compelling, 1-2 sentences max, easy to understand for a general audience.
Focus on neuroscience, psychology, or interesting phenomena. Do NOT include quotation marks.
Just output the fact text only, nothing else.`,
    promo: `Write a short, evocative tagline for a dream-tracking app called DreamCoach.
It should be 1 sentence, poetic, mystical, and inspiring. Do NOT include quotation marks.
Output only the tagline.`,
  };

  const prompt = prompts[videoType] || prompts.fact;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 150, temperature: 0.9 },
  };

  // Available models for Google AI Studio (generativelanguage.googleapis.com)
  // gemini-2.5-flash is the current generation and works for this project
  const STUDIO_MODELS = [
    { id: "gemini-2.5-flash",     api: "v1beta" },
    { id: "gemini-flash-latest",  api: "v1beta" },
    { id: "gemini-2.5-flash-lite", api: "v1beta" },
  ];
  // Versioned model IDs for Vertex AI (aiplatform.googleapis.com)
  const VERTEX_MODELS = ["gemini-2.0-flash-001", "gemini-1.5-flash-002", "gemini-1.5-flash-001"];

  // 1️⃣ Try Google AI Studio endpoint with GEMINI_API_KEY (AIzaSy... format key)
  const studioKey = process.env.GEMINI_API_KEY;
  if (studioKey) {
    for (const { id: modelId, api } of STUDIO_MODELS) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/${api}/models/${modelId}:generateContent?key=${studioKey}`;
        const res = await axios.post(endpoint, body, {
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
        });
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          logger.info(`[dreamVideo] Gemini fact generated via AI Studio key (${modelId})`);
          return text;
        }
      } catch (err) {
        const status = err.response?.status || "?";
        const detail = err.response?.data?.error?.message?.slice(0, 120) || "";
        logger.warn(`[dreamVideo] AI Studio key model ${modelId} failed (${status}) ${detail}`);
      }
    }
  }

  // 2️⃣ Try Vertex AI with x-goog-api-key header (GCP / Vertex AI key)
  if (vertexApiKey) {
    for (const modelId of VERTEX_MODELS) {
      try {
        const endpoint = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${modelId}:generateContent`;
        const res = await axios.post(endpoint, body, {
          headers: { "x-goog-api-key": vertexApiKey, "Content-Type": "application/json" },
          timeout: 30000,
        });
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          logger.info(`[dreamVideo] Gemini fact generated via Vertex API key (${modelId})`);
          return text;
        }
      } catch (err) {
        const status = err.response?.status || "?";
        logger.warn(`[dreamVideo] Vertex API key model ${modelId} failed (${status})`);
      }
    }
  }

  // 3️⃣ Fall back to Vertex AI with service account token (OAuth ADC)
  for (const modelId of VERTEX_MODELS) {
    try {
      const endpoint = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${modelId}:generateContent`;
      const token = await getVertexToken();
      const res = await axios.post(endpoint, body, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 30000,
      });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) {
        logger.info(`[dreamVideo] Gemini fact generated via Vertex ADC (${modelId})`);
        return text;
      }
    } catch (err) {
      const status = err.response?.status || "?";
      logger.warn(`[dreamVideo] Vertex ADC model ${modelId} failed (${status})`);
    }
  }

  logger.warn("[dreamVideo] All Gemini attempts failed, using fallback fact");
  return FALLBACK_FACTS[Math.floor(Math.random() * FALLBACK_FACTS.length)];
}

// ─── Generate dream image with Vertex AI Imagen 3 ────────────────────────────
async function generateDreamImage(fact) {
  try {
    const token = await getVertexToken();
    const imagePrompt = `Dreamlike surreal digital art for a dream about: ${fact.substring(0, 120)}.
Style: ethereal, deep purple and gold tones, cosmic nebula background, floating particles,
soft glowing light, mystical, cinematic. No text. 9:16 vertical format.`;

    const endpoint = `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${IMAGEN_MODEL}:predict`;
    const res = await axios.post(
      endpoint,
      {
        instances: [{ prompt: imagePrompt }],
        parameters: { sampleCount: 1, aspectRatio: "9:16" },
      },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    const base64 = res.data?.predictions?.[0]?.bytesBase64Encoded;
    if (!base64) throw new Error("No image data returned from Imagen");

    // Upload to Firebase Storage and return public URL
    const bucket = admin.storage().bucket();
    const fileName = `dream-video-images/${Date.now()}.jpg`;
    const file = bucket.file(fileName);

    await file.save(Buffer.from(base64, "base64"), {
      metadata: { contentType: "image/jpeg" },
    });
    await file.makePublic();

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    logger.info("[dreamVideo] Imagen generated image:", publicUrl);
    return publicUrl;
  } catch (err) {
    logger.warn("[dreamVideo] Imagen failed, using placeholder:", err.message);
    return "";
  }
}

// ─── Render Remotion video via Lambda ────────────────────────────────────────
async function renderVideo(composition, inputProps) {
  if (!SERVE_URL) {
    throw new Error("DREAM_REMOTION_SERVE_URL env variable is not set. Deploy the Remotion bundle first.");
  }

  if (process.env.REMOTION_AWS_ACCESS_KEY_ID) {
    process.env.REMOTION_AWS_ACCESS_KEY_ID = process.env.REMOTION_AWS_ACCESS_KEY_ID.trim();
  }
  if (process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
    process.env.REMOTION_AWS_SECRET_ACCESS_KEY = process.env.REMOTION_AWS_SECRET_ACCESS_KEY.trim();
  }

  // Small framesPerLambda keeps each renderer Lambda well under the 900s AWS ceiling.
  // DreamIllustration (1800 frames, 4 Veo clips): 150 fpl → 12 Lambdas, each renders ~5s
  //   of output and decodes at most 1 Veo clip → completes in ~100-200s.
  // FreudJungVideo (1350 frames, image-based):    200 fpl → 7  Lambdas, safe.
  // DreamFact/Promo (540 frames, static image):   180 fpl → 3  Lambdas, safe.
  const totalFrames = inputProps?.scenes?.length ? 1800 : (inputProps?.insights?.length ? 1350 : 540);
  const framesPerLambda = inputProps?.scenes?.length ? 150   // illustration — Veo clips
                        : inputProps?.insights?.length ? 200 // Freud/Jung — image
                        : 180;                               // fact/promo — static

  const { renderId, bucketName } = await renderMediaOnLambda({
    region: REMOTION_REGION,
    functionName: FUNCTION_NAME,
    serveUrl: SERVE_URL,
    composition,
    inputProps,
    codec: "h264",
    imageFormat: "jpeg",
    maxRetries: 2,
    privacy: "public",
    framesPerLambda,
  });

  // Poll until complete — up to 25 min (300 × 5s) for long Veo-backed videos
  for (let attempt = 0; attempt < 300; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const progress = await getRenderProgress({ renderId, bucketName, functionName: FUNCTION_NAME, region: REMOTION_REGION });
    if (progress.fatalErrorEncountered) throw new Error(`Remotion render error: ${progress.errors?.[0]?.message}`);
    if (progress.done) return progress.outputFile;
  }
  throw new Error("Remotion render timed out after 10 minutes");
}

// ─── Upload to YouTube ────────────────────────────────────────────────────────
async function uploadToYouTube({ videoUrl, title, description, tags }) {
  if (!fs.existsSync(YT_SECRET_PATH) || !fs.existsSync(YT_TOKEN_PATH)) {
    throw new Error("YouTube credentials not found. Add dreamcoach_yt_secret.json and dreamcoach_yt_tokens.json to functions/");
  }

  const secrets = JSON.parse(fs.readFileSync(YT_SECRET_PATH, "utf8"));
  const tokens  = JSON.parse(fs.readFileSync(YT_TOKEN_PATH,  "utf8"));
  const oauth2  = new google.auth.OAuth2(
    secrets.web.client_id,
    secrets.web.client_secret,
    secrets.web.redirect_uris[0]
  );
  oauth2.setCredentials(tokens);
  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  // Download video to temp file
  const tmpPath = path.join(os.tmpdir(), `dreamcoach-${Date.now()}.mp4`);
  const videoRes = await fetch(videoUrl);
  const buffer = await videoRes.buffer();
  fs.writeFileSync(tmpPath, buffer);

  try {
    const res = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, tags, categoryId: "22" },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      },
      media: { mimeType: "video/mp4", body: fs.createReadStream(tmpPath) },
    });

    const videoId = res.data.id;
    // Refresh tokens if updated
    if (oauth2.credentials.access_token !== tokens.access_token) {
      fs.writeFileSync(YT_TOKEN_PATH, JSON.stringify(oauth2.credentials, null, 2));
    }
    return { videoId, url: `https://www.youtube.com/shorts/${videoId}` };
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

// ─── Upload to Instagram ──────────────────────────────────────────────────────
async function uploadToInstagram(videoUrl, caption) {
  const igUserId = IG_USER_ID();
  const token    = IG_TOKEN();
  if (!igUserId || !token) throw new Error("DREAM_IG_USER_ID or DREAM_IG_ACCESS_TOKEN not set");

  // Create container
  const containerRes = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media_type: "REELS", video_url: videoUrl, caption, access_token: token }),
  });
  const container = await containerRes.json();
  if (container.error) throw new Error(`IG container error: ${JSON.stringify(container.error)}`);

  // Poll for processing
  const creationId = container.id;
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await fetch(
      `https://graph.facebook.com/v20.0/${creationId}?fields=status_code&access_token=${token}`
    );
    const status = await statusRes.json();
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR") throw new Error("IG video processing failed");
  }

  // Publish
  const publishRes = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  const published = await publishRes.json();
  if (published.error) throw new Error(`IG publish error: ${JSON.stringify(published.error)}`);

  return { postId: published.id, url: `https://www.instagram.com/reel/${published.id}/` };
}

// ─── Post Instagram Story (image or video) ───────────────────────────────────
// Posts a Story that appears for 24h — drives traffic back to the Reel.
// imageUrl → image story (instant); videoUrl → video story (needs processing poll).
async function postInstagramStory({ imageUrl, videoUrl }) {
  const igUserId = IG_USER_ID();
  const token    = IG_TOKEN();
  if (!igUserId || !token) {
    logger.warn("[dreamVideo] IG Story skipped: no credentials");
    return null;
  }
  try {
    const payload = videoUrl
      ? { media_type: "STORIES", video_url: videoUrl, access_token: token }
      : { media_type: "STORIES", image_url: imageUrl, access_token: token };

    const containerRes = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const container = await containerRes.json();
    if (container.error) throw new Error(`IG Story container error: ${JSON.stringify(container.error)}`);

    const creationId = container.id;

    // Video stories need processing time; image stories are instant
    if (videoUrl) {
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const statusRes = await fetch(
          `https://graph.facebook.com/v20.0/${creationId}?fields=status_code&access_token=${token}`
        );
        const status = await statusRes.json();
        if (status.status_code === "FINISHED") break;
        if (status.status_code === "ERROR") throw new Error("IG Story video processing failed");
      }
    }

    const publishRes = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: creationId, access_token: token }),
    });
    const published = await publishRes.json();
    if (published.error) throw new Error(`IG Story publish error: ${JSON.stringify(published.error)}`);

    const storyUrl = `https://www.instagram.com/stories/${igUserId}/${published.id}/`;
    logger.info(`[dreamVideo] IG Story posted: ${storyUrl}`);
    return { storyId: published.id, url: storyUrl };
  } catch (err) {
    logger.warn("[dreamVideo] IG Story failed (non-fatal):", err.message);
    return null;
  }
}

// ─── Post to Facebook ─────────────────────────────────────────────────────────
async function postToFacebook({ imageUrl, message }) {
  const pageId = FB_PAGE_ID();
  const token  = FB_TOKEN();
  if (!pageId || !token) throw new Error("DREAM_FB_PAGE_ID or DREAM_FB_ACCESS_TOKEN not set");

  const res = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: imageUrl, message, access_token: token }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Facebook API error: ${JSON.stringify(data.error)}`);

  const postId = data.post_id || data.id;
  const actualId = postId?.includes("_") ? postId.split("_")[1] : postId;
  return { postId, url: `https://www.facebook.com/${pageId}/posts/${actualId}` };
}

// ─── Post to Twitter/X ────────────────────────────────────────────────────────
async function postToTwitter({ text, imageUrl }) {
  const client = twitterClient();
  if (!process.env.DREAM_TWITTER_APP_KEY) throw new Error("Twitter credentials not set");

  let mediaId;
  if (imageUrl) {
    const imgRes    = await fetch(imageUrl);
    const imgBuffer = await imgRes.buffer();
    mediaId = await client.v1.uploadMedia(imgBuffer, { mimeType: "image/jpeg" });
  }

  const tweetPayload = { text };
  if (mediaId) tweetPayload.media = { media_ids: [mediaId] };

  const { data } = await client.v2.tweet(tweetPayload);
  return { postId: data.id, url: `https://twitter.com/DreamCoachApp/status/${data.id}` };
}

// ─── Core pipeline ────────────────────────────────────────────────────────────
async function runDreamVideoPipeline(slot, runId) {
  const videoType   = slot === "morning" ? "fact" : "promo";
  const composition = videoType === "fact" ? "DreamFactVideo" : "DreamPromoVideo";
  const effectiveRunId = runId || `${Date.now()}-${slot}`;

  logger.info(`[dreamVideo] Starting ${slot} pipeline (${composition})`);

  const logRef = db.collection("social_posts").doc(effectiveRunId);
  await logRef.set({
    runId: effectiveRunId,
    slot,
    videoType,
    composition,
    status: "started",
    site: "dream-analytics",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  try {
    // 1. Generate content
    const fact       = await generateDreamFact(process.env.VERTEX_AI_KEY, videoType);
    const imageUrl   = await generateDreamImage(fact);
    const factNumber = Math.floor(Math.random() * 1000) + 1;

    await logRef.update({ fact, imageUrl, status: "content_ready", updatedAt: new Date().toISOString() });

    // 2. Generate AI ambient audio (type-specific prompt pool for variety)
    const audioUrl = await generateDreamAudio(fact, "en", videoType === "fact" ? "fact" : "promo");
    await logRef.update({ audioUrl: audioUrl || "", updatedAt: new Date().toISOString() });

    // 3. Render video
    const inputProps =
      videoType === "fact"
        ? { fact, factNumber, imageUrl, audioUrl, ctaText: "Track your dreams at DreamCoach", ctaUrl: "dream-analytics.com" }
        : { headline: fact, subheadline: "AI-powered dream analysis, journaling & pattern tracking", audioUrl, ctaUrl: "dream-analytics.com" };

    const videoUrl = await renderVideo(composition, inputProps);
    logger.info("[dreamVideo] Video rendered:", videoUrl);
    await logRef.update({ videoUrl, status: "video_rendered", updatedAt: new Date().toISOString() });

    const results = {};

    // 3. YouTube
    try {
      const ytTitle = videoType === "fact"
        ? `Dream Fact #${factNumber}: ${fact.substring(0, 60)}...`
        : `DreamCoach – ${fact.substring(0, 70)}`;
      const ytDesc  = `${fact}\n\n🌙 Track and analyse your dreams at dream-analytics.com\n\n#DreamCoach #DreamFacts #Dreaming #LucidDreaming #DreamJournal #Psychology #Sleep`;

      results.youtube = await uploadToYouTube({ videoUrl, title: ytTitle, description: ytDesc, tags: ["DreamCoach","dream facts","lucid dreaming","dream journal","psychology"] });
      logger.info("[dreamVideo] YouTube:", results.youtube.url);
    } catch (e) {
      logger.error("[dreamVideo] YouTube failed:", e.message);
      results.youtube = { error: e.message };
    }

    // 4. Instagram Reel
    try {
      const igCaption = `${fact}\n\n🌙 Decode your dreams with DreamCoach\n🔗 Link in bio → dream-analytics.com\n\n#DreamCoach #Dreams #DreamFacts #LucidDream #DreamJournal #Subconscious #SleepScience`;
      results.instagram = await uploadToInstagram(videoUrl, igCaption);
      logger.info("[dreamVideo] Instagram:", results.instagram.url);
    } catch (e) {
      logger.error("[dreamVideo] Instagram failed:", e.message);
      results.instagram = { error: e.message };
    }

    // 4b. Instagram Story — the rendered video (text + fact baked in)
    try {
      results.instagramStory = await postInstagramStory({ videoUrl });
    } catch (e) { logger.warn("[dreamVideo] IG Story failed:", e.message); }

    // 5. Facebook
    try {
      const fbMessage = `✨ ${fact}\n\n🌙 Track and unlock the secrets of your dreams with DreamCoach – AI-powered dream analysis.\n👉 dream-analytics.com\n\n#DreamCoach #Dreams #DreamFacts #Psychology`;
      results.facebook = await postToFacebook({ imageUrl: imageUrl || "https://dream-analytics.com/img/og.png", message: fbMessage });
      logger.info("[dreamVideo] Facebook:", results.facebook.url);
    } catch (e) {
      logger.error("[dreamVideo] Facebook failed:", e.message);
      results.facebook = { error: e.message };
    }

    // 6. Twitter/X — skipped (add credentials to enable)

    await logRef.update({
      status: "success",
      results,
      updatedAt: new Date().toISOString(),
    });

    logger.info("[dreamVideo] Pipeline complete for slot:", slot, results);

  } catch (err) {
    logger.error("[dreamVideo] Pipeline failed:", err.message);
    await logRef.update({
      status: "error",
      error: err.message,
      updatedAt: new Date().toISOString(),
    });
  }
}

// ─── Helper: download image URL → Firebase Storage → public HTTPS URL ────────
async function cacheImageToStorage(imageUrl, destFolder = "dream-psychologist-photos") {
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buffer = await resp.buffer();
    const ext    = imageUrl.split("?")[0].split(".").pop()?.toLowerCase() || "jpg";
    const mime   = ext === "png" ? "image/png" : "image/jpeg";
    const fname  = `${destFolder}/${Date.now()}.${ext}`;
    const bucket = admin.storage().bucket();
    const file   = bucket.file(fname);
    await file.save(buffer, { contentType: mime, public: true });
    const [metadata] = await file.getMetadata();
    return `https://storage.googleapis.com/${bucket.name}/${fname}`;
  } catch (err) {
    logger.warn("[dreamVideo] cacheImageToStorage failed:", err.message);
    return ""; // Empty string signals caller to use fallback
  }
}

// ─── Helper: robust JSON parse from Gemini response ──────────────────────────
function parseGeminiJson(text) {
  if (!text) return null;
  // Strip markdown code fences
  let clean = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(clean); } catch (_) {}
  // Try to extract the outermost JSON object
  const start = clean.indexOf("{");
  const end   = clean.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

// ─── Pexels stock video service ───────────────────────────────────────────────
function pickBestPexelsFile(video) {
  const files = (video.video_files || [])
    .filter(f => f.file_type === "video/mp4" && f.link)
    .filter(f => Math.max(f.width || 0, f.height || 0) <= 1920)
    .map(f => {
      const h = f.height || 0, w = f.width || 0;
      const shorter = Math.min(w, h) || 0;
      const orientScore = h >= w ? 100 : 0;
      const resScore = shorter >= 720 && shorter <= 1080 ? 100 : shorter >= 540 ? 70 : 10;
      return { file: f, score: orientScore + resScore };
    })
    .sort((a, b) => b.score - a.score);
  return files.length ? files[0].file : null;
}

async function fetchPexelsClips(queries, count = 4) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) { logger.warn("[dreamVideo] PEXELS_API_KEY not set; skipping b-roll"); return []; }
  const clips = [];
  const seenIds = new Set();
  for (const query of queries) {
    if (clips.length >= count) break;
    try {
      const res = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=12&orientation=portrait&size=medium`,
        { headers: { Authorization: apiKey } }
      );
      if (!res.ok) { logger.warn(`[dreamVideo] Pexels failed (${res.status}) for "${query}"`); continue; }
      const data = await res.json();
      const shuffled = (data.videos || []).sort(() => Math.random() - 0.5);
      for (const vid of shuffled) {
        if (clips.length >= count) break;
        if (seenIds.has(vid.id)) continue;
        const dur = vid.duration || 0;
        if (dur < 7 || dur > 30) continue;
        const file = pickBestPexelsFile(vid);
        if (!file) continue;
        seenIds.add(vid.id);
        clips.push({ url: file.link, photographer: vid.user?.name || "Pexels", sourceUrl: vid.url, query });
      }
    } catch (err) { logger.warn(`[dreamVideo] Pexels error for "${query}":`, err.message); }
  }
  logger.info(`[dreamVideo] Pexels: fetched ${clips.length}/${count} clips`);
  return clips;
}

// ─── Audio prompt pools — varied per content type ────────────────────────────
// Rotated daily so each video sounds different. 22s max (ElevenLabs Sound Effects limit).
// LoopingAudio.tsx crossfades multiple instances for seamless full-video playback.
const AUDIO_POOLS = {
  illustration: [
    "Ethereal cosmic dreamscape, floating light particles, deep space resonance, slow celestial drift. No vocals.",
    "Surreal underwater cavern, crystalline droplets, bioluminescent glow, deep oceanic pulse. No vocals.",
    "Ancient forest at midnight, bioluminescent mushrooms, gentle wind, mystical insect hum. No vocals.",
    "Time-lapse desert night sky, meteor shower, Milky Way ambience, vast cosmic silence. No vocals.",
    "Misty mountain valley at dawn, distant temple bells, birds awakening, peaceful nature. No vocals.",
  ],
  freud: [
    "Viennese study at candlelight, antique clock, crackling fire, leather-bound books atmosphere. No vocals.",
    "Mysterious psychological chamber, echoing footsteps, distant piano, contemplative tension. No vocals.",
    "Victorian library at midnight, quill scratching, thunderstorm outside, deep intellectual focus. No vocals.",
  ],
  jung: [
    "Ancient cave paintings glowing, tribal drums softly, archetypal symbols humming, timeless energy. No vocals.",
    "Swiss Alps at dusk, monastery bells, contemplative wind, vast alpine silence, spiritual depth. No vocals.",
    "Alchemical laboratory, bubbling elixirs, mystical fire glow, transformation energy, deep wonder. No vocals.",
  ],
  fact: [
    "Telescope observatory at night, electronic hum, wonder and curiosity, cosmic vastness. No vocals.",
    "Laboratory of the mind, soft scientific beeps, neural pathways sparkling, discovery moment. No vocals.",
    "Neuroscience museum at night, holographic brain, soft blue light, curiosity and awe. No vocals.",
  ],
  promo: [
    "Invitation to a dream, rising orchestral swell, golden light, cinematic hope. No vocals.",
    "Moonlit meditation garden, singing bowls, gentle stream, soft invitation. No vocals.",
  ],
  personal: [
    "Personal dream journey, intimate cinematic piano, emotional depth, introspective warmth. No vocals.",
    "Memories surfacing in water, gentle piano echoes, soft strings, personal nostalgia. No vocals.",
    "Inner landscape exploration, deep breathing rhythm, soft pulse, consciousness awakening. No vocals.",
    "Childhood wonder returning, music box melody, soft warmth, safe dreamlike comfort. No vocals.",
  ],
  monthly: [
    "Year in review cinematic score, rising strings, achievement glow, reflective warmth. No vocals.",
    "Journey map unfolding, orchestral adventure, discovery and growth, hopeful cadence. No vocals.",
  ],
};

function pickAudioPrompt(type, seed) {
  const pool = AUDIO_POOLS[type] || AUDIO_POOLS.illustration;
  const idx  = Math.abs(seed || Date.now()) % pool.length;
  return pool[idx];
}

// ─── Generate dream ambient audio via ElevenLabs Sound Effects ───────────────
// Produces 22s of AI-generated ambient music (no copyright, commercially safe).
// LoopingAudio.tsx on the Remotion side crossfades seamlessly for full duration.
async function generateDreamAudio(dreamTitle, language = "en", audioType = "illustration") {
  const xiKey = process.env.ELEVENLABS_API_KEY;
  if (!xiKey) {
    logger.warn("[dreamVideo] ELEVENLABS_API_KEY not set — skipping audio generation");
    return "";
  }
  try {
    // Pick a varied prompt from the pool — rotate daily per type for variety
    const daySeed = Math.floor(Date.now() / 86400000);
    const basePrompt = pickAudioPrompt(audioType, daySeed);
    const prompt = `${basePrompt} Theme: ${dreamTitle.substring(0, 60)}`;

    logger.info(`[dreamVideo] ElevenLabs audio (type=${audioType}): "${prompt.substring(0, 80)}…"`);
    const res = await axios.post(
      "https://api.elevenlabs.io/v1/sound-generation",
      { text: prompt, duration_seconds: 22, prompt_influence: 0.45 },
      {
        headers: { "xi-api-key": xiKey.trim(), "Content-Type": "application/json" },
        responseType: "arraybuffer",
        timeout: 60000,
      }
    );

    // Upload to Firebase Storage (public) so Remotion Lambda can download it
    const bucket = admin.storage().bucket(FIREBASE_STORAGE_BUCKET);
    const fname  = `dream-audio/${Date.now()}-${audioType}.mp3`;
    const file   = bucket.file(fname);
    await file.save(Buffer.from(res.data), { contentType: "audio/mpeg" });
    await file.makePublic();
    const audioUrl = `https://storage.googleapis.com/${FIREBASE_STORAGE_BUCKET}/${fname}`;
    logger.info(`[dreamVideo] ElevenLabs audio generated: ${audioUrl}`);
    return audioUrl;
  } catch (err) {
    const msg = err.response?.data?.toString?.()?.slice(0, 200) || err.message;
    logger.warn("[dreamVideo] ElevenLabs audio failed (video will be silent):", msg);
    return "";
  }
}

// ─── Copy a public URL to the Remotion S3 bucket (same region = fast download) ─
// Remotion Lambda runs in us-east-1. Veo videos live in Firebase Storage (GCS
// us-central1). Cross-cloud download from Lambda is slow and hits the 15-min
// Lambda timeout. Copying first to the Remotion S3 bucket eliminates that delay.
const REMOTION_S3_BUCKET = "remotionlambda-useast1-di0xuqpokc";
const serveUrl = process.env.DREAM_REMOTION_SERVE_URL || "https://remotionlambda-useast1-di0xuqpokc.s3.us-east-1.amazonaws.com/sites/dreamcoach-videos-v4/index.html";

async function copyVideoToS3(publicUrl, s3Key) {
  try {
    const awsAccessKeyId = process.env.REMOTION_AWS_ACCESS_KEY_ID;
    const awsSecretAccessKey = process.env.REMOTION_AWS_SECRET_ACCESS_KEY;
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      logger.warn("[dreamVideo] S3 copy skipped: no AWS creds");
      return publicUrl; // fall back to original URL
    }

    // Download the video into memory (Veo clips are 10-40MB)
    const dlRes = await axios.get(publicUrl, { responseType: "arraybuffer", timeout: 120000 });
    const videoBuffer = Buffer.from(dlRes.data);
    logger.info(`[dreamVideo] S3 copy: downloaded ${(videoBuffer.length / 1e6).toFixed(1)} MB`);

    const s3 = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: awsAccessKeyId.trim(), secretAccessKey: awsSecretAccessKey.trim() },
    });
    await s3.send(new PutObjectCommand({
      Bucket: REMOTION_S3_BUCKET,
      Key: s3Key,
      Body: videoBuffer,
      ContentType: "video/mp4",
      ACL: "public-read",
    }));

    const s3Url = `https://${REMOTION_S3_BUCKET}.s3.us-east-1.amazonaws.com/${s3Key}`;
    logger.info(`[dreamVideo] S3 copy: uploaded → ${s3Url}`);
    return s3Url;
  } catch (err) {
    logger.warn("[dreamVideo] S3 copy failed (will use GCS URL):", err.message);
    return publicUrl; // graceful fallback
  }
}

// ─── Veo clip cache helpers ───────────────────────────────────────────────────
// Cache key: first 40 hex chars of a SHA-1-like hash derived from the prompt.
// Stored in Firestore collection `veo_cache/{key}` → { s3Url, prompt, createdAt }
// TTL: 30 days (clips older than that are regenerated so content stays fresh).
const VEO_CACHE_DAYS = 30;

function veoPromptKey(prompt) {
  // Simple deterministic hash — no crypto module needed in Node.js 18+
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    hash = Math.imul(31, hash) + prompt.charCodeAt(i) | 0;
  }
  // Combine with a length-based salt to reduce collisions on long prompts
  const salt = (prompt.length * 7919) | 0;
  const combined = ((hash ^ salt) >>> 0).toString(16).padStart(8, "0");
  // Also use first 32 chars + last 32 chars of prompt as additional key material
  const excerpt = (prompt.slice(0, 32) + prompt.slice(-32))
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 24);
  return `${combined}_${excerpt}`;
}

async function getVeoCache(prompt) {
  try {
    const key = veoPromptKey(prompt);
    const doc = await db.collection("veo_cache").doc(key).get();
    if (!doc.exists) return null;
    const data = doc.data();
    // Expire after VEO_CACHE_DAYS days so content stays fresh
    const ageMs = Date.now() - new Date(data.createdAt).getTime();
    if (ageMs > VEO_CACHE_DAYS * 24 * 60 * 60 * 1000) {
      logger.info(`[dreamVideo] Veo cache expired for key ${key}`);
      return null;
    }
    logger.info(`[dreamVideo] ♻️ Veo cache HIT — reusing clip (saved ~$0.40): ${key}`);
    return data.s3Url;
  } catch (err) {
    logger.warn("[dreamVideo] Veo cache read error (non-fatal):", err.message);
    return null;
  }
}

async function setVeoCache(prompt, s3Url) {
  try {
    const key = veoPromptKey(prompt);
    await db.collection("veo_cache").doc(key).set({
      s3Url,
      prompt: prompt.slice(0, 500), // store truncated prompt for debugging
      createdAt: new Date().toISOString(),
    });
    logger.info(`[dreamVideo] Veo cache SET: ${key}`);
  } catch (err) {
    logger.warn("[dreamVideo] Veo cache write error (non-fatal):", err.message);
  }
}

// ─── Google Veo 3.1 video generation (with Pexels fallback) ─────────────────
async function generateSceneWithVeo3(prompt) {
  // ── Cache check — skip Veo entirely if we already have a clip for this prompt ──
  const cached = await getVeoCache(prompt);
  if (cached) return cached;

  try {
    const token = await getVertexToken();
    // Correct model ID: veo-3.1-generate-001 via v1beta1 API
    const endpoint = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/veo-3.1-generate-001:predictLongRunning`;

    const body = {
      instances: [{
        prompt,
        negativePrompt: "humans, people, faces, person, man, woman, child, body parts, hands, text, watermark, logo, ugly, blurry, realistic photography",
      }],
      parameters: {
        aspectRatio: "9:16",
        sampleCount: 1,
        durationSeconds: 8,
        personGeneration: "dont_allow",
        storageUri: `gs://${GCP_PROJECT}.firebasestorage.app/dream-veo3-output/`,
      },
    };

    const initRes = await axios.post(endpoint, body, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 60000,
    });

    const operationName = initRes.data?.name;
    if (!operationName) throw new Error("Veo 3.1 returned no operation name");
    logger.info(`[dreamVideo] Veo 3.1 operation started: ${operationName}`);

    // Vertex AI Video generation uses fetchPredictOperation (POST) to poll —
    // NOT a GET on the operation name (that returns 404).
    const fetchOpEndpoint = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/veo-3.1-generate-001:fetchPredictOperation`;

    // Poll every 15s for up to 10 minutes (40 attempts)
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(r => setTimeout(r, 15000));
      const pollToken = await getVertexToken();
      const pollRes = await axios.post(
        fetchOpEndpoint,
        { operationName },
        { headers: { Authorization: `Bearer ${pollToken}`, "Content-Type": "application/json" }, timeout: 30000 }
      );
      logger.info(`[dreamVideo] Veo 3.1 poll #${attempt + 1}: done=${pollRes.data.done}`);
      if (!pollRes.data.done) continue;

      // Check multiple response paths Veo might use
      const predictions = pollRes.data.response?.predictions;
      const videoEntry   = Array.isArray(predictions) && predictions[0];
      let gcsUri = videoEntry?.video?.uri || videoEntry?.gcsUri || videoEntry?.uri
                || videoEntry?.bytesBase64Encoded; // some versions embed base64

      if (!gcsUri) {
        const videos = pollRes.data.response?.videos || pollRes.data.metadata?.videos;
        gcsUri = Array.isArray(videos) && (videos[0]?.gcsUri || videos[0]?.uri);
      }
      // Log full response for debugging on first success
      if (!gcsUri) {
        logger.warn("[dreamVideo] Veo 3.1 done but no URI — response:", JSON.stringify(pollRes.data).slice(0, 500));
        throw new Error("Veo 3.1 done but no video URI in response");
      }

      // Make the GCS object publicly readable so Remotion Lambda (on AWS) can download it.
      // Firebase Storage objects are private by default.
      if (gcsUri.startsWith("gs://")) {
        try {
          const bucketName = gcsUri.split("/")[2];
          const objectPath = gcsUri.split("/").slice(3).join("/");
          await admin.storage().bucket(bucketName).file(objectPath).makePublic();
          logger.info(`[dreamVideo] Veo 3.1 made public: ${objectPath}`);
        } catch (pubErr) {
          logger.warn("[dreamVideo] Veo 3.1 makePublic failed (will try anyway):", pubErr.message);
        }
      }

      // gs://BUCKET/path → public GCS HTTPS URL
      const gcsPublicUrl = gcsUri.startsWith("gs://")
        ? gcsUri.replace("gs://", "https://storage.googleapis.com/")
        : gcsUri;

      // Copy to S3 (same region as Remotion Lambda) to avoid cross-cloud download timeouts
      const s3Key = `veo3-clips/${Date.now()}-scene.mp4`;
      const finalUrl = await copyVideoToS3(gcsPublicUrl, s3Key);
      logger.info(`[dreamVideo] Veo 3.1 generated: ${finalUrl}`);

      // ── Cache this clip so future pipeline runs with the same prompt skip Veo ──
      await setVeoCache(prompt, finalUrl);

      return finalUrl;
    }
    throw new Error("Veo 3.1 timed out after 10 minutes");
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.warn("[dreamVideo] Veo 3.1 failed (will use Pexels):", msg);
    return null;
  }
}

// ─── Content generators for new video types ───────────────────────────────────
async function generateDreamIllustrationContent(language = "en") {
  const lang = language === "he" ? "Hebrew" : "English";
  const prompt = `Create a dream narrative in ${lang} for a 60-second short video that visually illustrates an imagined dream.
Return ONLY a JSON object with this exact structure (no markdown, no extra text):
{
  "dreamTitle": "Poetic title (3-5 words)",
  "dreamSummary": "1-2 sentences setting the dream scene",
  "scenes": [
    {
      "narration": "Vivid first-person dream narration (1-2 sentences, max 25 words)",
      "researchNote": "Real sleep science fact related to this element (1 sentence, cite researcher or brain area)",
      "pexelsQuery": "3-5 word Pexels search query for relevant atmospheric footage"
    }
  ]
}
Requirements: exactly 4 scenes, evocative first-person voice, real neuroscience citations, visually descriptive Pexels queries (nature/architecture/sky/space/water etc). Language: ${lang}.`;

  const studioKey = process.env.GEMINI_API_KEY;
  if (studioKey) {
    for (const model of ["gemini-2.5-flash", "gemini-flash-latest"]) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${studioKey}`,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1500, temperature: 0.85 } },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        const parsed = parseGeminiJson(text);
        if (parsed?.dreamTitle && Array.isArray(parsed.scenes) && parsed.scenes.length === 4) {
          logger.info(`[dreamVideo] Dream illustration content generated via ${model}`);
          return parsed;
        }
      } catch (err) { logger.warn(`[dreamVideo] Illustration content gen failed (${model}):`, err.message); }
    }
  }
  // Fallback
  return language === "he" ? {
    dreamTitle: "המדרגות האינסופיות",
    dreamSummary: "אתה מוצא את עצמך עולה במדרגות זוהרות שנמשכות אל תוך ערפל זהוב...",
    scenes: [
      { narration: "אתה עומד מול מדרגות שנעלמות לתוך עננים זוהרים.", researchNote: "תנועה אנכית בחלומות קשורה לתחושות שאיפה (Hall, 1966).", pexelsQuery: "staircase fog mystical light" },
      { narration: "כל מדרגה מאירה מתחת לרגלייך — אתה חסר משקל.", researchNote: "חוסר כובד בחלומות מפעיל את המערכת הוסטיבולרית של המוח.", pexelsQuery: "floating clouds weightless sky" },
      { narration: "המדרגות מתפצלות. שני כיוונים. אתה בוחר.", researchNote: "נקודות החלטה בחלומות מייצגות בחירות שהמוח מתרגל בשינה.", pexelsQuery: "crossroads path forest choice" },
      { narration: "דלת עם אור שופע. אתה מרגיש מוכן לפתוח אותה.", researchNote: "סמלי סף מייצגים מעבר בחיים — עיבוד תת-מודע.", pexelsQuery: "door glowing light threshold" },
    ],
  } : {
    dreamTitle: "The Infinite Staircase",
    dreamSummary: "You find yourself climbing stairs that stretch endlessly into golden mist...",
    scenes: [
      { narration: "You stand before stairs that vanish into luminous clouds above you.", researchNote: "Vertical movement in dreams correlates with feelings of growth and ambition (Hall, 1966).", pexelsQuery: "staircase fog mystical light" },
      { narration: "Each step glows beneath your feet — you feel completely weightless.", researchNote: "Weightlessness in dreams activates the vestibular cortex, same area processing real balance.", pexelsQuery: "floating clouds sky serene" },
      { narration: "The stairs fork. Two paths beckon. The choice feels monumental.", researchNote: "Decision points in dreams reflect real choices the sleeping brain is actively rehearsing.", pexelsQuery: "crossroads path forest choice" },
      { narration: "A glowing door waits at the top. Light pours through every edge.", researchNote: "Threshold imagery represents life transitions — the brain processing change during REM sleep.", pexelsQuery: "door glowing light threshold" },
    ],
  };
}

async function generateFreudJungContent(psychologist, language = "en") {
  const isHe  = language === "he";
  const names = {
    freud: { en: "Sigmund Freud", he: "זיגמונד פרויד" },
    jung:  { en: "Carl Jung",     he: "קרל יונג"     },
  };
  const name = names[psychologist][language];
  const lang = isHe ? "Hebrew" : "English";
  const prompt = `Create content in ${lang} for a short educational video about ${names[psychologist].en}'s dream theory.
Return ONLY a JSON object (no markdown, no extra text):
{
  "psychologistName": "${name}",
  "quote": "One of ${names[psychologist].en}'s most famous authentic quotes about dreams (use a real, verified quote)",
  "insights": [
    {
      "icon": "single emoji",
      "title": "2-4 word concept title",
      "description": "2-3 sentence clear explanation of this dream theory concept with practical application"
    }
  ]
}
Requirements: exactly 3 insights, authentic psychological concepts only, clear and engaging for general audience, language: ${lang}.`;

  const studioKey = process.env.GEMINI_API_KEY;
  if (studioKey) {
    for (const model of ["gemini-2.5-flash", "gemini-flash-latest"]) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${studioKey}`,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1200, temperature: 0.7 } },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        const parsed = parseGeminiJson(text);
        if (parsed?.quote && Array.isArray(parsed.insights) && parsed.insights.length === 3) {
          logger.info(`[dreamVideo] Freud/Jung content generated via ${model}`);
          return { ...parsed, psychologistName: name };
        }
      } catch (err) { logger.warn(`[dreamVideo] Freud/Jung content gen failed (${model}):`, err.message); }
    }
  }
  // Fallback
  const fallbacks = {
    freud: {
      en: { psychologistName: "Sigmund Freud", quote: "Dreams are the royal road to the unconscious.", insights: [
        { icon: "💭", title: "Wish Fulfillment", description: "Every dream expresses a hidden wish. The dreaming mind fulfills desires suppressed by your waking consciousness." },
        { icon: "🎭", title: "Manifest & Latent", description: "What you see in a dream is disguised. The true meaning — the latent content — hides beneath the surface imagery." },
        { icon: "🔑", title: "Free Association", description: "Say the first thing that comes to mind about each dream symbol. Your unconscious guides the decoding." },
      ]},
      he: { psychologistName: "זיגמונד פרויד", quote: "חלומות הם הדרך המלכותית אל תת-המודע.", insights: [
        { icon: "💭", title: "מימוש משאלות", description: "כל חלום מביע משאלה נסתרת. המוח הישן ממלא רצונות שמודעותך מדכאת." },
        { icon: "🎭", title: "תוכן גלוי ונסתר", description: "מה שאתה רואה בחלום הוא מוסווה. המשמעות האמיתית מסתתרת מאחורי הסמלים." },
        { icon: "🔑", title: "אסוציאציות חופשיות", description: "אמור את הדבר הראשון שעולה בדעתך לגבי כל סמל בחלום. תת-מודעך ינחה אותך." },
      ]},
    },
    jung: {
      en: { psychologistName: "Carl Jung", quote: "The dream is a little hidden door in the innermost and most secret recesses of the soul.", insights: [
        { icon: "🌊", title: "Collective Unconscious", description: "Your dreams draw from a shared pool of human symbols — archetypes — present in every person across cultures and history." },
        { icon: "👤", title: "Shadow Self", description: "Dreams often show you your Shadow — the hidden, repressed parts of yourself. Confronting them brings wholeness." },
        { icon: "🔮", title: "Individuation", description: "Recurring dream themes are your psyche's call to grow. Each symbol is a message from your deeper self to become whole." },
      ]},
      he: { psychologistName: "קרל יונג", quote: "החלום הוא דלת נסתרת קטנה לחדרי הנפש הפנימיים ביותר.", insights: [
        { icon: "🌊", title: "האגדה הקולקטיבית", description: "החלומות שלך שואבים ממאגר משותף של סמלים אנושיים — ארכיטיפים — הקיימים בכל אדם בכל התרבויות." },
        { icon: "👤", title: "הצל", description: "חלומות מראים לך את הצל שלך — החלקים הנסתרים והמודחקים בך. התמודדות איתם מביאה שלמות." },
        { icon: "🔮", title: "אינדיבידואציה", description: "נושאים חוזרים בחלומות הם קריאה מהנפש לצמוח. כל סמל הוא מסר מה-self העמוק שלך." },
      ]},
    },
  };
  return fallbacks[psychologist][language] || fallbacks.freud.en;
}

// Psychologist photos (public domain Wikimedia Commons)
const PSYCHOLOGIST_PHOTOS = {
  freud: "https://upload.wikimedia.org/wikipedia/commons/3/36/Sigmund_Freud_LIFE.jpg",
  jung:  "https://upload.wikimedia.org/wikipedia/commons/0/00/CGJung.jpg",
};

// ─── Dream Illustration pipeline ─────────────────────────────────────────────
async function runDreamIllustrationPipeline(slot, runId, language = "en") {
  const composition = language === "he" ? "DreamIllustrationVideoHe" : "DreamIllustrationVideo";
  const effectiveRunId = runId || `${Date.now()}-illustration-${language}`;
  const ctaUrl = language === "he" ? "dream-analytics.com/he/" : "dream-analytics.com";

  logger.info(`[dreamVideo] Starting illustration pipeline (${language})`);

  const logRef = db.collection("social_posts").doc(effectiveRunId);
  await logRef.set({
    runId: effectiveRunId, slot, videoType: `illustration_${language}`,
    composition, status: "started", site: "dream-analytics",
    language, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  try {
    // 1. Generate structured content via Gemini
    const content = await generateDreamIllustrationContent(language);
    logger.info(`[dreamVideo] Dream illustration content: "${content.dreamTitle}"`);
    // Log full script so it's visible in logs and saved to Firestore
    content.scenes.forEach((s, i) => {
      logger.info(`[dreamVideo] Scene ${i+1} narration: ${s.narration}`);
      logger.info(`[dreamVideo] Scene ${i+1} research:  ${s.researchNote}`);
    });
    await logRef.update({
      dreamTitle: content.dreamTitle,
      dreamSummary: content.dreamSummary,
      contentScenes: content.scenes.map(s => ({ narration: s.narration, researchNote: s.researchNote })),
      status: "content_ready",
      updatedAt: new Date().toISOString(),
    });

    // 2. Fetch Pexels clips for each scene (try Veo 3 first per scene)
    const scenes = [];
    for (let i = 0; i < content.scenes.length; i++) {
      const sceneData = content.scenes[i];
      let videoUrl = "";

      // Try Veo 3 first (premium, AI-generated dream visuals)
      // Prompts are intentionally abstract/cosmic — no humans/faces to avoid RAI filter
      const veoPrompt = `Abstract surreal dreamscape inspired by: "${sceneData.pexelsQuery || sceneData.narration}". Macro cinematic footage of ethereal light particles, deep purple and gold energy swirls, cosmic nebula clouds, glowing mist, floating crystal formations, slowly drifting stardust. No humans, no faces, no figures. Pure abstract imagery. Dreamlike atmosphere. 9:16 vertical.`;
      const veoUrl = await generateSceneWithVeo3(veoPrompt);
      if (veoUrl) {
        videoUrl = veoUrl;
        logger.info(`[dreamVideo] Scene ${i + 1} using Veo 3`);
      } else {
        // Fall back to Pexels
        const clips = await fetchPexelsClips([sceneData.pexelsQuery, "dream ethereal fog", "surreal landscape"], 1);
        if (clips.length > 0) {
          videoUrl = clips[0].url;
          logger.info(`[dreamVideo] Scene ${i + 1} using Pexels: ${clips[0].url}`);
        }
      }
      scenes.push({ narration: sceneData.narration, researchNote: sceneData.researchNote, videoUrl });
    }

    // 3. Generate AI ambient audio
    const audioUrl = await generateDreamAudio(content.dreamTitle, language, "illustration");
    await logRef.update({
      status: "media_ready",
      audioUrl: audioUrl || "",
      updatedAt: new Date().toISOString(),
    });

    // 4. Render video via Remotion Lambda
    const inputProps = {
      dreamTitle: content.dreamTitle,
      dreamSummary: content.dreamSummary,
      scenes,
      audioUrl,
      language,
      platform: "youtube", // overridden per-platform at upload time
      ctaUrl,
    };

    // Render YouTube version
    const videoUrl = await renderVideo(composition, { ...inputProps, platform: "youtube" });
    logger.info("[dreamVideo] Dream illustration video rendered:", videoUrl);
    await logRef.update({ videoUrl, status: "video_rendered", updatedAt: new Date().toISOString() });

    const results = {};
    const pexelsCredits = scenes.filter(s => s.videoUrl && s.videoUrl.includes("pexels")).map((_, i) => `Scene ${i+1}`).join(", ");
    const creditLine = pexelsCredits ? `\nStock footage: Pexels (${pexelsCredits})` : "";

    // 4. YouTube
    try {
      const ytTitle = language === "he"
        ? `חלום: ${content.dreamTitle} 🌙 מה המדע אומר?`
        : `Dream Walkthrough: ${content.dreamTitle} 🌙 What Science Says`;
      const ytDesc  = language === "he"
        ? `${content.dreamSummary}\n\n🔬 מבוסס על מחקרי חלומות אמיתיים\n🌙 נתח את החלומות שלך ב-dream-analytics.com/he/\n\n#DreamCoach #חלומות #פסיכולוגיה #שינה${creditLine}`
        : `${content.dreamSummary}\n\n🔬 Backed by real dream research\n🌙 Analyze YOUR dreams at dream-analytics.com\n\n#DreamCoach #Dreams #DreamScience #SleepScience #Neuroscience${creditLine}`;
      results.youtube = await uploadToYouTube({ videoUrl, title: ytTitle, description: ytDesc,
        tags: language === "he" ? ["חלומות","DreamCoach","פסיכולוגיה"] : ["DreamCoach","dreams","dream science","neuroscience"] });
      logger.info("[dreamVideo] YouTube (illustration):", results.youtube.url);
    } catch (e) { logger.error("[dreamVideo] YouTube illustration failed:", e.message); results.youtube = { error: e.message }; }

    // 5. Instagram Reel
    try {
      const igVideoUrl = videoUrl;
      const igCaption = language === "he"
        ? `${content.dreamTitle} 🌙\n\n${content.dreamSummary}\n\n🔬 מבוסס על מחקר אמיתי\n🔗 קישור בביו → dream-analytics.com/he/\n\n#DreamCoach #חלומות #שינה #פסיכולוגיה`
        : `${content.dreamTitle} 🌙\n\n${content.dreamSummary}\n\n🔬 Backed by real dream science\n🔗 Link in bio → dream-analytics.com\n\n#DreamCoach #Dreams #DreamScience #LucidDream #Sleep`;
      results.instagram = await uploadToInstagram(igVideoUrl, igCaption);
      logger.info("[dreamVideo] Instagram (illustration):", results.instagram.url);
    } catch (e) { logger.error("[dreamVideo] Instagram illustration failed:", e.message); results.instagram = { error: e.message }; }

    // 5b. Instagram Story — the full rendered video (text + scenes baked in)
    try {
      results.instagramStory = await postInstagramStory({ videoUrl });
    } catch (e) { logger.warn("[dreamVideo] IG Story (illustration) failed:", e.message); }

    await logRef.update({ status: "success", results, updatedAt: new Date().toISOString() });
    logger.info("[dreamVideo] Illustration pipeline complete:", results);
  } catch (err) {
    logger.error("[dreamVideo] Illustration pipeline failed:", err.message);
    await logRef.update({ status: "error", error: err.message, updatedAt: new Date().toISOString() });
    throw err;
  }
}

// ─── Freud / Jung pipeline ────────────────────────────────────────────────────
async function runFreudJungPipeline(slot, runId, psychologist = "freud", language = "en") {
  const composition = language === "he" ? "FreudJungVideoHe" : "FreudJungVideo";
  const effectiveRunId = runId || `${Date.now()}-${psychologist}-${language}`;
  const psychPage = psychologist === "freud" ? "freud" : "jung";
  const ctaUrl = language === "he"
    ? `dream-analytics.com/he/${psychPage}`
    : `dream-analytics.com/${psychPage}`;

  logger.info(`[dreamVideo] Starting Freud/Jung pipeline (${psychologist}, ${language})`);

  const logRef = db.collection("social_posts").doc(effectiveRunId);
  await logRef.set({
    runId: effectiveRunId, slot, videoType: `${psychologist}_${language}`,
    composition, status: "started", site: "dream-analytics",
    language, psychologist, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  try {
    // 1. Generate content via Gemini
    const content = await generateFreudJungContent(psychologist, language);
    logger.info(`[dreamVideo] Freud/Jung content: "${content.quote.substring(0, 60)}..."`);
    await logRef.update({ quote: content.quote, status: "content_ready", updatedAt: new Date().toISOString() });

    // 2. Always generate a unique Imagen portrait (different every time — no Wikimedia)
    let photoUrl = "";
    try {
      const psychName = psychologist === "freud" ? "Sigmund Freud" : "Carl Jung";
      const styleVariants = [
        "Dramatic oil painting portrait, chiaroscuro lighting, deep shadows",
        "Impressionist watercolor portrait, soft brushstrokes, warm candlelight",
        "Art nouveau portrait, intricate patterns, golden hour glow",
        "Expressionist portrait, bold brushstrokes, intense psychological energy",
      ];
      const style = styleVariants[Math.floor(Date.now() / 86400000) % styleVariants.length];
      const imgPrompt = `${style} of ${psychName}, the famous psychologist and dream theorist. Deep purple and ${psychologist === "freud" ? "amber" : "teal"} tones, scholarly atmosphere, no text. 9:16 vertical.`;
      photoUrl = await generateDreamImage(imgPrompt);
      logger.info(`[dreamVideo] Psychologist portrait generated by Imagen: ${photoUrl}`);
    } catch (imgErr) {
      logger.warn("[dreamVideo] Imagen portrait failed:", imgErr.message);
      photoUrl = "";
    }

    // 3. Generate AI ambient audio for Freud/Jung (scholarly, mysterious tone)
    const psychAudioPrompt = psychologist === "freud"
      ? `Freud ${content.psychologistName} dream analysis`
      : `Jung ${content.psychologistName} collective unconscious archetypes`;
    const audioUrl = await generateDreamAudio(psychAudioPrompt, language, psychologist);
    await logRef.update({ audioUrl: audioUrl || "", updatedAt: new Date().toISOString() });

    // 4. Render
    const inputProps = {
      psychologist, psychologistName: content.psychologistName,
      quote: content.quote, insights: content.insights,
      photoUrl, audioUrl, language, ctaUrl,
      platform: "youtube",
    };

    const videoUrl = await renderVideo(composition, { ...inputProps, platform: "youtube" });
    logger.info("[dreamVideo] Freud/Jung video rendered:", videoUrl);
    await logRef.update({ videoUrl, status: "video_rendered", updatedAt: new Date().toISOString() });

    const results = {};
    const psychName = content.psychologistName;

    // 4. YouTube
    try {
      const ytTitle = language === "he"
        ? `מה ${psychName} אומר על החלומות שלך 🌙`
        : `What ${psychName} Says About YOUR Dreams 🌙`;
      const ytDesc = language === "he"
        ? `"${content.quote}"\n\n— ${psychName}\n\n🌙 נתח את החלומות שלך בשיטת ${psychName} ב-dream-analytics.com/he/\n\n#DreamCoach #${psychologist === "freud" ? "פרויד" : "יונג"} #חלומות #פסיכולוגיה`
        : `"${content.quote}"\n\n— ${psychName}\n\n🌙 Analyze YOUR dreams using ${psychName.split(" ")[1]}'s method at dream-analytics.com\n\n#DreamCoach #${psychologist === "freud" ? "Freud" : "Jung"} #Dreams #Psychology #DreamAnalysis`;
      results.youtube = await uploadToYouTube({ videoUrl, title: ytTitle, description: ytDesc,
        tags: language === "he" ? ["DreamCoach","פרויד","יונג","חלומות"] : ["DreamCoach","Freud","Jung","dreams","psychology","dream analysis"] });
      logger.info("[dreamVideo] YouTube (Freud/Jung):", results.youtube.url);
    } catch (e) { logger.error("[dreamVideo] YouTube Freud/Jung failed:", e.message); results.youtube = { error: e.message }; }

    // 5. Instagram Reel
    try {
      const igVideoUrl = videoUrl;
      const igCaption = language === "he"
        ? `"${content.quote}"\n\n— ${psychName} 🌙\n\n${content.insights.map(i => `${i.icon} ${i.title}`).join(" · ")}\n\n🔗 קישור בביו → dream-analytics.com/he/\n\n#DreamCoach #${psychologist === "freud" ? "פרויד" : "יונג"} #חלומות #פסיכולוגיה`
        : `"${content.quote}"\n\n— ${psychName} 🌙\n\n${content.insights.map(i => `${i.icon} ${i.title}`).join(" · ")}\n\n🔗 Link in bio → dream-analytics.com\n\n#DreamCoach #${psychologist === "freud" ? "Freud" : "Jung"} #Dreams #Psychology`;
      results.instagram = await uploadToInstagram(igVideoUrl, igCaption);
      logger.info("[dreamVideo] Instagram (Freud/Jung):", results.instagram.url);
    } catch (e) { logger.error("[dreamVideo] Instagram Freud/Jung failed:", e.message); results.instagram = { error: e.message }; }

    // 5b. Instagram Story — the rendered video itself (has all text/animations baked in)
    try {
      results.instagramStory = await postInstagramStory({ videoUrl });
    } catch (e) { logger.warn("[dreamVideo] IG Story (Freud/Jung) failed:", e.message); }

    await logRef.update({ status: "success", results, updatedAt: new Date().toISOString() });
    logger.info("[dreamVideo] Freud/Jung pipeline complete:", results);
  } catch (err) {
    logger.error("[dreamVideo] Freud/Jung pipeline failed:", err.message);
    await logRef.update({ status: "error", error: err.message, updatedAt: new Date().toISOString() });
    throw err;
  }
}

// ─── Scheduled exports ────────────────────────────────────────────────────────
const SECRETS = [
  // VERTEX_AI_KEY is a regular env var from .env (not a secret)
  "DREAM_IG_ACCESS_TOKEN",
  "DREAM_IG_USER_ID",
  "DREAM_FB_ACCESS_TOKEN",
  "DREAM_FB_PAGE_ID",
  "REMOTION_AWS_ACCESS_KEY_ID",
  "REMOTION_AWS_SECRET_ACCESS_KEY",
  "DREAM_REMOTION_SERVE_URL",
  "DREAM_REMOTION_FUNCTION_NAME",
  "PEXELS_API_KEY",
  "ELEVENLABS_API_KEY",
  "ADMIN_SECRET_KEY",
];

exports.dreamVideoMorning = onSchedule(
  {
    schedule: "0 8 * * *",
    timeZone: "UTC",
    region: "us-central1",
    timeoutSeconds: 3600,
    memory: "1GiB",
    secrets: SECRETS,
  },
  async () => runDreamVideoPipeline("morning")
);

exports.dreamVideoEvening = onSchedule(
  {
    schedule: "0 20 * * *",
    timeZone: "UTC",
    region: "us-central1",
    timeoutSeconds: 3600,
    memory: "1GiB",
    secrets: SECRETS,
  },
  async () => runDreamVideoPipeline("evening")
);

// Manually-triggerable HTTP endpoint (admin only)
const { onRequest } = require("firebase-functions/v2/https");
exports.triggerDreamVideo = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 3600,
    memory: "1GiB",
    secrets: SECRETS,
    cors: ["https://www.dream-analytics.com", "https://dream-analytics.com", "https://dreamanalysis-39322.web.app"],
  },
  async (req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const slot      = req.body?.slot      || "morning";
    const videoType = req.body?.videoType || "fact";   // fact | promo | illustration | illustration_he | freud | jung | freud_he | jung_he
    const language  = req.body?.language  || "en";
    const runId     = `${Date.now()}-${videoType}-${language}`;

    // Run synchronously — prevents Cloud Run CPU throttle after res.json()
    try {
      if (videoType === "illustration" || videoType === "illustration_he") {
        const lang = videoType === "illustration_he" ? "he" : language;
        await runDreamIllustrationPipeline(slot, runId, lang);
      } else if (videoType === "freud" || videoType === "freud_he") {
        const lang = videoType === "freud_he" ? "he" : language;
        await runFreudJungPipeline(slot, runId, "freud", lang);
      } else if (videoType === "jung" || videoType === "jung_he") {
        const lang = videoType === "jung_he" ? "he" : language;
        await runFreudJungPipeline(slot, runId, "jung", lang);
      } else {
        // Default: existing fact/promo pipeline
        await runDreamVideoPipeline(slot, runId);
      }
      res.json({ status: "success", slot, videoType, language, runId });
    } catch (err) {
      res.status(500).json({ status: "error", slot, videoType, language, runId, error: err.message });
    }
  }
);

// ─── New scheduled pipelines ──────────────────────────────────────────────────
// Dream Illustration (English) — Mon & Thu 9 AM UTC
exports.dreamIllustrationEN = onSchedule(
  { schedule: "0 9 * * 1,4", timeZone: "UTC", region: "us-central1", timeoutSeconds: 3600, memory: "1GiB", secrets: SECRETS },
  async () => runDreamIllustrationPipeline("morning", undefined, "en")
);

// Dream Illustration (Hebrew) — Tue & Fri 9 AM UTC
exports.dreamIllustrationHE = onSchedule(
  { schedule: "0 9 * * 2,5", timeZone: "UTC", region: "us-central1", timeoutSeconds: 3600, memory: "1GiB", secrets: SECRETS },
  async () => runDreamIllustrationPipeline("morning", undefined, "he")
);

// Freud / Jung (English, alternating) — Wed 9 AM UTC
exports.dreamFreudJungEN = onSchedule(
  { schedule: "0 9 * * 3", timeZone: "UTC", region: "us-central1", timeoutSeconds: 3600, memory: "1GiB", secrets: SECRETS },
  async () => {
    // Alternate Freud/Jung by week number
    const weekNum = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
    await runFreudJungPipeline("morning", undefined, weekNum % 2 === 0 ? "freud" : "jung", "en");
  }
);

// Freud / Jung (Hebrew) — Sat 9 AM UTC
exports.dreamFreudJungHE = onSchedule(
  { schedule: "0 9 * * 6", timeZone: "UTC", region: "us-central1", timeoutSeconds: 3600, memory: "1GiB", secrets: SECRETS },
  async () => {
    const weekNum = Math.floor(Date.now() / (7 * 24 * 3600 * 1000));
    await runFreudJungPipeline("morning", undefined, weekNum % 2 === 0 ? "freud" : "jung", "he");
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PRO FEATURE: Personal dream video for each submitted dream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip polite AI openers from analysis text so only the real content remains.
 * e.g. "בטח, בשמחה אנתח..." / "Sure, I'd be happy to analyze..." etc.
 */
function stripAnalysisOpener(analysis) {
  const openerPatterns = [
    /^(בטח|בשמחה|כמובן|אנסה|אשמח|בוודאי)[^.!?\n]*[.!?\n]+/i,
    /^(Sure|Of course|Certainly|I'd be happy|I will|Let me|I'll)[^.!?\n]*[.!?\n]+/i,
    /^[^.!?\n]{0,120}(לנתח|לבחון|לפרש|analyze|interpret|examine)[^.!?\n]*[.!?\n]+/i,
  ];
  let stripped = analysis.trim();
  for (const re of openerPatterns) {
    stripped = stripped.replace(re, "").trim();
  }
  // If nothing was stripped yet and the first sentence is < 80 chars, skip it
  if (stripped === analysis.trim()) {
    const firstDot = stripped.search(/[.!?\n]/);
    if (firstDot > 0 && firstDot < 100) {
      stripped = stripped.slice(firstDot + 1).trim();
    }
  }
  return stripped || analysis.trim();
}

/**
 * Call Vertex AI (Gemini) via service-account ADC — works in Cloud Functions
 * without any API key, using the project's default service account.
 */
async function callVertexGemini(prompt, maxOutputTokens = 300, temperature = 0.75) {
  const VERTEX_MODELS = ["gemini-2.0-flash-001", "gemini-1.5-flash-002"];
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens, temperature },
  };
  for (const modelId of VERTEX_MODELS) {
    try {
      const endpoint = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${modelId}:generateContent`;
      const token = await getVertexToken();
      const res = await axios.post(endpoint, body, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 30000,
      });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (text) return text;
    } catch (err) {
      logger.warn(`[personalVideo] Vertex ${modelId} failed: ${err.message?.slice(0, 80)}`);
    }
  }
  return null;
}

/**
 * Ask Gemini (via Vertex ADC) for a punchy analysis headline.
 * Separate call so it can't accidentally pick up polite openers.
 */
async function generateAnalysisHeadline(analysis, language = "en") {
  const lang = language === "he" ? "Hebrew" : "English";
  const clean = stripAnalysisOpener(analysis).substring(0, 1000);
  const prompt = `You are a Jungian dream analyst writing the closing title card for a short personal dream video.

Based on the following dream analysis, write ONE powerful insight sentence (20-35 words) that:
- Captures the single most meaningful psychological revelation
- Speaks directly to the dreamer ("you", "your", or in Hebrew: "אתה/ך", "שלך")
- Sounds poetic and emotionally resonant — NOT like a summary, but like a revelation
- Does NOT start with "Your dream shows", "The dream suggests" or any generic opener
- Is written entirely in ${lang}

Analysis:
"${clean}"

Return ONLY the headline sentence. No quotes, no explanation, no extra text.`;

  const result = await callVertexGemini(prompt, 120, 0.8);
  if (result) {
    return result.replace(/^["״"']+|["״"']+$/g, "").trim();
  }

  // Fallback: first real sentence from the stripped analysis
  const fallbackSentence = stripAnalysisOpener(analysis)
    .split(/[.!?]/)
    .map(s => s.trim())
    .find(s => s.length > 30);
  return fallbackSentence ||
    (language === "he" ? "החלום שלך נושא מסר עמוק על מסעך הפנימי." : "Your dream carries a profound message about your inner journey.");
}

/**
 * Parse a dream description into 3 scenes using Gemini.
 * Returns { scenes: [{narration, analysisNote, pexelsQuery}], analysisHeadline }
 */
async function parseDreamIntoScenes(description, analysis, language = "en") {
  const lang = language === "he" ? "Hebrew" : "English";
  const cleanAnalysis = stripAnalysisOpener(analysis);

  const prompt = `You are a creative dream video director.
Given a user's dream description and its Jungian analysis, extract 3 visual scenes for a short video.
Each scene should be a specific moment from the dream, with a brief narration and a one-sentence insight from the analysis.

Dream description: "${description.substring(0, 600)}"
AI Analysis (core content, polite openers already stripped): "${cleanAnalysis.substring(0, 800)}"

Return ONLY a JSON object with this exact structure (no markdown, no extra text):
{
  "scenes": [
    {
      "narration": "COPY 1-2 sentences VERBATIM from the dream description — exact wording, no paraphrasing",
      "analysisNote": "1 concise sentence linking this scene moment to the Jungian analysis",
      "pexelsQuery": "3-4 keywords for finding a matching stock video clip (e.g. 'misty forest night fog')"
    }
  ]
}

CRITICAL RULES:
- "narration" MUST be an exact verbatim quote from the dream description — do NOT rewrite or summarise
- Cover the beginning, middle and end of the dream with the 3 scenes
- All text must be in ${lang}
- Return exactly 3 scenes`;

  let scenes = null;
  try {
    const raw = await callVertexGemini(prompt, 700, 0.7);
    if (raw) {
      const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.scenes) && parsed.scenes.length === 3) {
        scenes = parsed.scenes;
      }
    }
  } catch (err) {
    logger.warn("[personalVideo] Gemini scene parse failed:", err.message);
  }

  // Fallback: split description at sentence boundaries (not word chunks)
  if (!scenes) {
    // Split description into natural sentences / clauses
    const sentences = description
      .split(/(?<=[.!?—\n])\s+|(?<=[\u05D0-\u05EA]{3,}[,—])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);
    // Bucket sentences into 3 roughly equal groups
    const total = sentences.length;
    const size  = Math.ceil(total / 3);
    const buckets = [
      sentences.slice(0, size).join(" "),
      sentences.slice(size, size * 2).join(" "),
      sentences.slice(size * 2).join(" "),
    ].map(b => b || description.substring(0, 140)); // never empty
    const analysisLines = stripAnalysisOpener(cleanAnalysis)
      .split(/[.!?]/).map(s => s.trim()).filter(s => s.length > 20);
    scenes = [0, 1, 2].map(i => ({
      narration:    buckets[i].substring(0, 200),
      analysisNote: analysisLines[i] || analysisLines[0] || cleanAnalysis.substring(0, 100),
      pexelsQuery:  "dream surreal ethereal",
    }));
  }

  // Always generate the headline via a dedicated call
  const analysisHeadline = await generateAnalysisHeadline(analysis, language);

  return { scenes, analysisHeadline };
}

/**
 * Generates a personal dream video for a Pro user after they submit a dream.
 * Called fire-and-forget from analyzeDream in index.js.
 * Saves videoUrl + videoStatus to dreams/{dreamId}.
 */
async function generatePersonalDreamVideo({ dreamId, userId, description, analysis, userName, language, dreamDate }) {
  const db = admin.firestore();
  const dreamRef = db.collection("dreams").doc(dreamId);

  try {
    logger.info(`[personalVideo] Starting for dream ${dreamId}`);
    await dreamRef.update({ videoStatus: "generating", videoStatusAt: new Date().toISOString() });

    // 1. Parse dream into 3 scenes
    const parsed = await parseDreamIntoScenes(description, analysis, language);
    const { scenes: rawScenes, analysisHeadline } = parsed;

    // 2. Generate visuals: scene 1 with Veo (hero), scenes 2-3 with Pexels (cost-effective)
    const scenes = [];
    for (let i = 0; i < Math.min(rawScenes.length, 3); i++) {
      const s = rawScenes[i];
      let videoUrl = "";

      if (i === 0) {
        // Hero scene: Veo 3.1 for the most impactful visual
        const veoPrompt = `Abstract surreal dreamscape inspired by: "${s.pexelsQuery || s.narration.substring(0, 60)}". Macro cinematic footage of ethereal light particles, deep purple and gold energy swirls, cosmic nebula clouds, glowing mist. No humans, no faces, no figures. Pure abstract imagery. 9:16 vertical.`;
        videoUrl = await generateSceneWithVeo3(veoPrompt) || "";
      }

      if (!videoUrl) {
        // Scenes 2-3 (and fallback for scene 1): free Pexels stock
        const clips = await fetchPexelsClips([s.pexelsQuery, "dream ethereal surreal fog"], 1);
        videoUrl = clips[0]?.url || "";
      }

      scenes.push({ narration: s.narration, analysisNote: s.analysisNote, videoUrl });
    }

    // 3. Generate audio
    const audioUrl = await generateDreamAudio(
      description.substring(0, 60),
      language,
      "personal"
    );

    // 4. Format date
    const dateLabel = language === "he"
      ? new Date(dreamDate || Date.now()).toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" })
      : new Date(dreamDate || Date.now()).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

    // 5. Render with Remotion Lambda
    const composition = language === "he" ? "DreamPersonalVideoHe" : "DreamPersonalVideo";
    const videoUrl = await renderVideo(composition, {
      dreamTitle:       description.substring(0, 50).trim() + (description.length > 50 ? "…" : ""),
      dreamDate:        dateLabel,
      userName:         (userName || "You").split(" ")[0],
      scenes,
      analysisHeadline,
      audioUrl,
      language,
      ctaUrl:           language === "he" ? "dream-analytics.com/he/" : "dream-analytics.com",
    });

    // 6. Save to Firestore
    await dreamRef.update({
      videoUrl,
      videoStatus: "ready",
      videoGeneratedAt: new Date().toISOString(),
    });
    logger.info(`[personalVideo] ✅ Done for dream ${dreamId}: ${videoUrl}`);
    return videoUrl;

  } catch (err) {
    logger.error(`[personalVideo] ❌ Failed for dream ${dreamId}:`, err.message);
    await dreamRef.update({ videoStatus: "error", videoError: err.message }).catch(() => {});
    return null;
  }
}

// Export for use from index.js
exports.generatePersonalDreamVideo = generatePersonalDreamVideo;

// ─────────────────────────────────────────────────────────────────────────────
// PRO FEATURE: Monthly dream recap video
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a monthly recap video for a single Pro user.
 * Returns the video URL or null on failure.
 */
async function generateMonthlyRecapVideoForUser({ userId, userName, dreams, monthLabel, language }) {
  try {
    logger.info(`[monthlyRecap] Generating for user ${userId} (${dreams.length} dreams)`);
    const db = admin.firestore();

    // Use Gemini to extract highlights and themes from all dreams
    const lang = language === "he" ? "Hebrew" : "English";
    const dreamTexts = dreams.slice(0, 10).map((d, i) =>
      `Dream ${i + 1} (${d.dreamDate || "?"}): "${(d.description || "").substring(0, 150)}" | Analysis: "${(d.analysis || "").substring(0, 100)}"`
    ).join("\n");

    const geminiPrompt = `You are summarizing ${dreams.length} dreams recorded by ${userName} in ${monthLabel}.
For each dream, extract: a title (4-6 words), a 1-sentence excerpt, a 1-sentence analysis snippet, and an emoji.
Also identify 4-5 recurring themes across all dreams.
Return ONLY valid JSON (no markdown):
{
  "dreamHighlights": [{"emoji":"","title":"","excerpt":"","analysisSnippet":""}],
  "themes": ["theme1","theme2","theme3","theme4","theme5"]
}
IMPORTANT: All text in ${lang}.
Dreams:
${dreamTexts}`;

    let highlights = { dreamHighlights: [], themes: [] };
    try {
      const studioKey = process.env.GEMINI_API_KEY;
      if (studioKey) {
        const r = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${studioKey}`,
          { contents: [{ parts: [{ text: geminiPrompt }] }], generationConfig: { maxOutputTokens: 1200, temperature: 0.6 } },
          { timeout: 30000 }
        );
        const raw = r.data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        highlights = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
      }
    } catch (e) {
      logger.warn("[monthlyRecap] Gemini failed, using fallback:", e.message);
      // Fallback: use dreams as-is
      highlights.dreamHighlights = dreams.slice(0, 5).map(d => ({
        emoji: "🌙",
        title: (d.description || "Dream").substring(0, 30),
        excerpt: (d.description || "").substring(0, 100),
        analysisSnippet: (d.analysis || "").substring(0, 80),
      }));
      highlights.themes = ["Water", "Flight", "Transformation", "Light", "Home"];
    }

    // Build dreamsByDay for the bar chart
    const dayMap = {};
    dreams.forEach(d => {
      const day = parseInt((d.dreamDate || "").split("-")[2] || "1", 10);
      if (day) dayMap[day] = (dayMap[day] || 0) + 1;
    });
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 0).getDate();
    const dreamsByDay = Array.from({ length: daysInMonth }, (_, i) => ({
      day:   i + 1,
      count: dayMap[i + 1] || 0,
    }));

    // Count active days
    const activeDays = Object.keys(dayMap).length;

    // Generate audio
    const audioUrl = await generateDreamAudio(
      `${userName}'s ${monthLabel} Dreams`,
      language,
      "monthly"
    );

    // Render
    const composition = language === "he" ? "DreamMonthlyRecapHe" : "DreamMonthlyRecap";
    const videoUrl = await renderVideo(composition, {
      monthLabel,
      userName: (userName || "You").split(" ")[0],
      totalDreams: dreams.length,
      activeDays,
      dreamsByDay,
      dreams:  (highlights.dreamHighlights || []).slice(0, 5),
      themes:  (highlights.themes || []).slice(0, 5),
      audioUrl,
      language,
      ctaUrl:  language === "he" ? "dream-analytics.com/he/" : "dream-analytics.com",
    });

    // Save to Firestore under user's monthlyVideos subcollection
    const monthKey = monthLabel.replace(" ", "-").toLowerCase();
    await db.collection("users").doc(userId)
      .collection("monthlyVideos").doc(monthKey)
      .set({ videoUrl, monthLabel, generatedAt: new Date().toISOString(), totalDreams: dreams.length });

    logger.info(`[monthlyRecap] ✅ Done for ${userId}: ${videoUrl}`);
    return videoUrl;
  } catch (err) {
    logger.error(`[monthlyRecap] ❌ Failed for ${userId}:`, err.message);
    return null;
  }
}

exports.generateMonthlyRecapVideoForUser = generateMonthlyRecapVideoForUser;

// ─────────────────────────────────────────────────────────────────────────────
// PRO FEATURE: Sample demo video — posted to Facebook + Instagram
// CTA: "ומה החלום שלך מסמל? גלה ב dream-analytics.com/he/"
// ─────────────────────────────────────────────────────────────────────────────

async function runPersonalDemoPipeline(slot, runId, language = "en") {
  const effectiveRunId = runId || `${Date.now()}-personal-demo-${language}`;
  const db = admin.firestore();
  const logRef = db.collection("social_posts").doc(effectiveRunId);

  const ctaUrl = language === "he" ? "dream-analytics.com/he/" : "dream-analytics.com";
  const ctaText = language === "he"
    ? "ומה החלום שלך מסמל? גלה ב dream-analytics.com/he/"
    : "What does your dream mean? Find out at dream-analytics.com";

  // Sample dream data — realistic, engaging, anonymised
  const DEMO_DREAMS = {
    en: {
      dreamTitle: "The Train That Never Arrived",
      dreamDate:  new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      userName:   "Alex",
      scenes: [
        {
          narration: "I was waiting on a deserted platform. The clock showed 3 AM and the train was already two hours late. I couldn't leave.",
          analysisNote: "Waiting at a station represents a life transition where the next step feels delayed or out of your control.",
          videoUrl: "",
        },
        {
          narration: "A stranger sat beside me and said: 'The train always comes — but only when you stop watching the clock.'",
          analysisNote: "Dream figures often carry messages from the unconscious — this stranger may be your own inner wisdom.",
          videoUrl: "",
        },
        {
          narration: "Suddenly the platform filled with light. The train arrived, but it was made entirely of glass and I could see through every wall.",
          analysisNote: "Transparent structures in dreams often symbolise a desire for clarity, honesty, or a fear of being seen.",
          videoUrl: "",
        },
      ],
      analysisHeadline: "You are at a crossroads — your unconscious is urging patience and trust in the process.",
    },
    he: {
      dreamTitle: "הרכבת שלא הגיעה",
      dreamDate:  new Date().toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" }),
      userName:   "יובל",
      scenes: [
        {
          narration: "חיכיתי ברציף נטוש. השעון הראה 3 לפנות בוקר והרכבת כבר שעתיים באיחור. לא יכולתי לעזוב.",
          analysisNote: "המתנה בתחנה מייצגת מעבר בחיים שבו הצעד הבא מרגיש מעוכב או מחוץ לשליטתך.",
          videoUrl: "",
        },
        {
          narration: "זר ישב לידי ואמר: 'הרכבת תמיד מגיעה — אבל רק כשאתה מפסיק להסתכל על השעון.'",
          analysisNote: "דמויות בחלום לרוב נושאות מסרים מהלא-מודע — הזר הזה עשוי להיות החוכמה הפנימית שלך.",
          videoUrl: "",
        },
        {
          narration: "פתאום הרציף התמלא באור. הרכבת הגיעה, אבל היא הייתה עשויה כולה מזכוכית ויכולתי לראות דרך כל קיר.",
          analysisNote: "מבנים שקופים בחלומות מסמלים לרוב רצון לבהירות, כנות, או פחד להיות נראה.",
          videoUrl: "",
        },
      ],
      analysisHeadline: "אתה בפרשת דרכים — הלא-מודע שלך דוחף לסבלנות ואמון בתהליך.",
    },
  };

  const demo = DEMO_DREAMS[language] || DEMO_DREAMS.en;

  await logRef.set({
    runId: effectiveRunId, slot, videoType: `personal_demo_${language}`,
    status: "started", site: "dream-analytics",
    language, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  try {
    // 1. Generate Veo clip for hero scene
    logger.info(`[personalDemo] Generating hero Veo clip`);
    const veoPrompt = `Abstract surreal train station dreamscape, ethereal platform glowing in purple mist, crystalline train made of light, cosmic fog, no humans, no faces, 9:16 vertical. Cinematic dreamlike atmosphere.`;
    const heroVeoUrl = await generateSceneWithVeo3(veoPrompt);
    if (heroVeoUrl) demo.scenes[0].videoUrl = heroVeoUrl;

    // 2. Pexels for scenes 2-3
    const [clip2, clip3] = await Promise.all([
      fetchPexelsClips(["misty platform night fog", "mysterious train station"], 1),
      fetchPexelsClips(["glass crystal architecture light", "transparent ethereal light"], 1),
    ]);
    if (clip2[0]) demo.scenes[1].videoUrl = clip2[0].url;
    if (clip3[0]) demo.scenes[2].videoUrl = clip3[0].url;

    // 3. Audio
    const audioUrl = await generateDreamAudio(demo.dreamTitle, language, "personal");

    // 4. Render
    const composition = language === "he" ? "DreamPersonalVideoHe" : "DreamPersonalVideo";
    const videoUrl = await renderVideo(composition, {
      ...demo,
      audioUrl,
      language,
      ctaUrl,
    });
    logger.info(`[personalDemo] Rendered: ${videoUrl}`);
    await logRef.update({ videoUrl, status: "video_rendered", updatedAt: new Date().toISOString() });

    const results = {};
    const caption = language === "he"
      ? `🌙 ניתוח חלומות מבוסס AI\n\nחלמת על רכבת שלא מגיעה? על בית מוכר אך זר? על טיסה חופשית?\n\n${ctaText}\n\n#חלומות #ניתוחחלומות #פסיכולוגיה #DreamCoach`
      : `🌙 AI-powered dream analysis\n\nDreamed of a train that never came? Of flying freely? Of a familiar stranger?\n\n${ctaText}\n\n#Dreams #DreamAnalysis #Psychology #DreamCoach`;

    // 5. Instagram Reel
    try {
      results.instagram = await uploadToInstagram(videoUrl, caption);
      logger.info("[personalDemo] Instagram:", results.instagram.url);
    } catch (e) {
      logger.error("[personalDemo] Instagram failed:", e.message);
      results.instagram = { error: e.message };
    }

    // 6. Instagram Story
    try {
      results.instagramStory = await postInstagramStory({ videoUrl });
    } catch (e) { logger.warn("[personalDemo] IG Story failed:", e.message); }

    // 7. Facebook
    try {
      results.facebook = await postToFacebook({ imageUrl: "", videoUrl, message: caption });
      logger.info("[personalDemo] Facebook:", results.facebook?.url);
    } catch (e) {
      logger.error("[personalDemo] Facebook failed:", e.message);
      results.facebook = { error: e.message };
    }

    await logRef.update({ results, status: "success", updatedAt: new Date().toISOString() });
    return { status: "success", videoUrl };
  } catch (err) {
    logger.error("[personalDemo] Error:", err.message);
    await logRef.update({ status: "error", error: err.message, updatedAt: new Date().toISOString() });
    return { status: "error", error: err.message };
  }
}

// ── Scheduled: personal demo EN — Tue + Thu 10 AM UTC ─────────────────────────
exports.dreamPersonalDemoEN = onSchedule(
  { schedule: "0 10 * * 2,4", timeZone: "UTC", region: "us-central1", timeoutSeconds: 3600, memory: "512MiB", cpu: 1, secrets: SECRETS },
  async () => runPersonalDemoPipeline("morning", undefined, "en")
);

// ── Scheduled: personal demo HE — Mon + Wed 10 AM UTC ─────────────────────────
exports.dreamPersonalDemoHE = onSchedule(
  { schedule: "0 10 * * 1,3", timeZone: "UTC", region: "us-central1", timeoutSeconds: 3600, memory: "512MiB", cpu: 1, secrets: SECRETS },
  async () => runPersonalDemoPipeline("morning", undefined, "he")
);

// ── Shared upload helpers (used by other pipelines like dreamCharacterPipeline.js) ─
exports.uploadToInstagram = uploadToInstagram;
exports.uploadToYouTube   = uploadToYouTube;
