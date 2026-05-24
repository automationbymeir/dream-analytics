/**
 * dreamCoachSlideRenderer.js
 * ---------------------------------------------------------------------------
 * Renders the DreamCoach IG carousel slides via Remotion Lambda, with
 * per-slide Nano Banana backgrounds tuned to the daily theme.
 *
 * Public:
 *   buildDreamCoachSlideUrls(content) → string[]
 *
 * `content` is the object returned by services/dreamCoachContent.js:
 *   { theme, cover, items: [{headline,body}], cta }
 */

const admin = require('firebase-admin');
const { renderStillOnLambda } = require('@remotion/lambda/client');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('firebase-functions');
const { loadGeminiSDK, getGeminiSDK } = require('./_genaiUtils');

// Read Remotion Lambda config from the same secrets the dream video pipeline
// already uses — keeps everything aligned with DreamCoach's own Remotion site.
const REGION = (process.env.DREAM_REMOTION_REGION || 'us-east-1').trim();
const FUNCTION_NAME = (process.env.DREAM_REMOTION_FUNCTION_NAME || 'remotion-render-4-0-452-mem3008mb-disk2048mb-900sec').trim();
const SERVE_URL = (process.env.DREAM_REMOTION_SERVE_URL || '').trim();

function trimAwsCreds() {
  if (process.env.REMOTION_AWS_ACCESS_KEY_ID) {
    process.env.REMOTION_AWS_ACCESS_KEY_ID =
      process.env.REMOTION_AWS_ACCESS_KEY_ID.trim();
  }
  if (process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
    process.env.REMOTION_AWS_SECRET_ACCESS_KEY =
      process.env.REMOTION_AWS_SECRET_ACCESS_KEY.trim();
  }
}

async function getGenAI() {
  if (!process.env.GEMINI_API_KEY) return null;
  await loadGeminiSDK();
  const { GoogleGenAI } = getGeminiSDK();
  if (!GoogleGenAI) return null;
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

/** Nano Banana → upload PNG to Firebase Storage → return public URL. */
async function generateBackground(genAI, prompt, runId, slideKey) {
  if (!genAI) return null;
  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const parts =
      (result &&
        result.candidates &&
        result.candidates[0] &&
        result.candidates[0].content &&
        result.candidates[0].content.parts) ||
      [];
    for (const p of parts) {
      if (p.inlineData && p.inlineData.data) {
        const buf = Buffer.from(p.inlineData.data, 'base64');
        const bucket = admin.storage().bucket();
        const dest = `instagram/dreamcoach/${runId}/bg_${slideKey}_${uuidv4()}.png`;
        const file = bucket.file(dest);
        await file.save(buf, {
          contentType: p.inlineData.mimeType || 'image/png',
          resumable: false,
          public: true,
          metadata: { cacheControl: 'public, max-age=86400' },
        });
        try { await file.makePublic(); } catch (e) { /* save() already public */ }
        return `https://storage.googleapis.com/${bucket.name}/${dest}`;
      }
    }
    return null;
  } catch (err) {
    logger.warn(`dreamCoachSlideRenderer: Nano Banana failed for ${slideKey}:`, err.message);
    return null;
  }
}

async function renderSlide(compositionId, inputProps) {
  trimAwsCreds();
  const { url } = await renderStillOnLambda({
    region: REGION,
    functionName: FUNCTION_NAME,
    serveUrl: SERVE_URL,
    composition: compositionId,
    inputProps,
    imageFormat: 'png',
    privacy: 'public',
    maxRetries: 2,
  });
  return url;
}

// ─── Background prompts ────────────────────────────────────────────────────
function coverPrompt(theme) {
  return (
    `Mystical dreamlike photographic background, 4:5 portrait, ` +
    `theme: "${theme.headline}". ` +
    `Style: ethereal cosmic atmosphere — deep midnight blue and violet, ` +
    `soft glowing nebulae, distant stars, floating dreamlike mist, ` +
    `crescent moon hinted softly off-center. ` +
    `Premium editorial mood. NO text, NO logos, NO watermarks. ` +
    `Bottom-right negative space for text overlay.`
  );
}
function factPrompt(theme, body) {
  return (
    `Cinematic dreamlike background image, 4:5 portrait, ` +
    `evoking: "${body.slice(0, 120)}". Theme context: "${theme.headline}". ` +
    `Style: surreal, soft focus, glowing colored mist, violet/indigo/midnight palette, ` +
    `subtle motion blur, dreamy lights, abstract not literal. ` +
    `NO text, NO logos, NO product photography, NO recognisable people. ` +
    `Center is darker to support text overlay.`
  );
}
function ctaPrompt(theme) {
  return (
    `Vibrant cosmic background, 4:5 portrait. ` +
    `Glowing crescent moon and gentle particle stars on a deep violet/indigo sky, ` +
    `soft volumetric light rays from the moon, mystical premium feel. ` +
    `NO text, NO logos. Clean center for text overlay.`
  );
}

/**
 * Build the carousel slides from the content payload.
 * Returns an ordered array of public PNG URLs ready to feed to IG.
 */
async function buildDreamCoachSlideUrls(content) {
  if (!content || !content.theme || !Array.isArray(content.items)) {
    throw new Error('buildDreamCoachSlideUrls: invalid content payload');
  }
  const { theme, cover, items, cta } = content;
  const hebrew = content.language !== 'en'; // default to RTL for HE, LTR only when content says EN
  const totalSteps = items.length + 2; // cover + items + cta
  const runId = `dccar_${Date.now()}_${uuidv4().slice(0, 8)}`;
  const genAI = await getGenAI();

  logger.info(
    `[dreamCoachSlideRenderer] theme="${theme.id}" lang=${content.language || 'he'} items=${items.length} runId=${runId}`
  );

  // 1. All Nano Banana backgrounds in parallel.
  const [coverBg, ctaBg, ...factBgs] = await Promise.all([
    generateBackground(genAI, coverPrompt(theme), runId, 'cover'),
    generateBackground(genAI, ctaPrompt(theme), runId, 'cta'),
    ...items.map((it, i) => generateBackground(genAI, factPrompt(theme, it.body), runId, `fact${i + 1}`)),
  ]);

  // 2. Lambda renders in parallel.
  const jobs = [];
  jobs.push(
    renderSlide('DCCoverSlide', {
      bgUrl: coverBg || undefined,
      themeHeadline: theme.headline,
      themeColor: theme.color,
      coverHeadline: cover.headline,
      coverSubline: cover.subline,
      hebrew,
    })
  );
  items.forEach((it, i) => {
    jobs.push(
      renderSlide('DCFactSlide', {
        bgUrl: factBgs[i] || undefined,
        index: i + 1,
        totalSteps,
        themeColor: theme.color,
        headline: it.headline,
        body: it.body,
        hebrew,
      })
    );
  });
  jobs.push(
    renderSlide('DCCtaSlide', {
      bgUrl: ctaBg || undefined,
      themeColor: theme.color,
      headline: cta.headline,
      subline: cta.subline,
      hebrew,
    })
  );

  const urls = await Promise.all(jobs);
  logger.info(`[dreamCoachSlideRenderer] rendered ${urls.length} stills`);
  return urls;
}

module.exports = { buildDreamCoachSlideUrls };
