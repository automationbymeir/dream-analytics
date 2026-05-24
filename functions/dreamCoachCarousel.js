/**
 * dreamCoachCarousel.js
 * ---------------------------------------------------------------------------
 * End-to-end pipeline that posts a Hebrew Instagram carousel for DreamCoach
 * with daily-rotating themes (dream symbols, sleep science, etc.) and a
 * mystical purple/midnight visual identity.
 *
 *   1. Gemini generates the day's content (cover, 4 facts, cta) for today's
 *      theme (services/dreamCoachContent.js).
 *   2. Nano Banana paints a dreamy cosmic background per slide.
 *   3. Remotion Lambda renders 6 stills at 1080×1350.
 *   4. Each slide is fed to the IG Graph API as a child container, then
 *      published as a CAROUSEL post.
 *   5. Writes a `schedulerLogs` entry (type: 'dreamcoach_carousel') so the
 *      admin Automation panel can show it alongside other automations.
 *
 * Triggered by:
 *   - cron `0 9 * * *` Asia/Jerusalem (one post per day)
 *   - onCall `triggerDreamCoachCarousel` (admin manual)
 *
 * Secrets required:
 *   - GEMINI_API_KEY                          (text + image gen)
 *   - DREAM_IG_USER_ID                   (the IG Business User ID for DreamCoach)
 *   - DREAM_IG_ACCESS_TOKEN              (long-lived page token)
 *   - REMOTION_AWS_ACCESS_KEY_ID / SECRET     (for Lambda)
 *
 * If DREAMCOACH_IG_* aren't set, the job runs end-to-end and logs the
 * rendered slide URLs but skips the publish step (so you can preview the
 * design before connecting IG).
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('firebase-functions');
const db = admin.firestore();
const { loadGeminiSDK, getGeminiSDK } = require('./services/_genaiUtils');
const { buildDreamCoachContent } = require('./services/dreamCoachContent');
const { buildDreamCoachSlideUrls } = require('./services/dreamCoachSlideRenderer');

function getIgUserId() {
  return (process.env.DREAM_IG_USER_ID || '').trim();
}
function getIgToken() {
  return (process.env.DREAM_IG_ACCESS_TOKEN || '').trim();
}

async function createIgChild(imageUrl) {
  const userId = getIgUserId();
  const token = getIgToken();
  const params = new URLSearchParams({
    image_url: imageUrl,
    is_carousel_item: 'true',
    access_token: token,
  });
  const res = await fetch(`https://graph.facebook.com/v20.0/${userId}/media`, {
    method: 'POST',
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG child container error: ${JSON.stringify(data.error)}`);
  return data.id;
}

async function publishCarousel(childIds, caption) {
  const userId = getIgUserId();
  const token = getIgToken();
  const createRes = await fetch(`https://graph.facebook.com/v20.0/${userId}/media`, {
    method: 'POST',
    body: new URLSearchParams({
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
      access_token: token,
    }),
  });
  const createData = await createRes.json();
  if (createData.error) throw new Error(`IG parent error: ${JSON.stringify(createData.error)}`);
  const parentId = createData.id;

  // Wait for the parent container to be ready.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await (
      await fetch(`https://graph.facebook.com/v20.0/${parentId}?fields=status_code&access_token=${token}`)
    ).json();
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error('IG parent container error');
  }

  const publishRes = await fetch(`https://graph.facebook.com/v20.0/${userId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: parentId, access_token: token }),
  });
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`IG publish error: ${JSON.stringify(publishData.error)}`);
  return publishData.id;
}

function buildCaption(content) {
  const { theme, cover, items, cta, language } = content;
  const lines = [];
  lines.push(`${cover.headline} ✨`, '');
  lines.push(`☾ ${theme.headline}`);
  lines.push(cover.subline);
  lines.push('');
  items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.headline}`);
  });
  lines.push('');
  lines.push(`🌙 ${cta.headline}`);
  lines.push(cta.subline);
  lines.push('');
  if (language === 'en') {
    lines.push('#dreams #dreaminterpretation #sleepscience #psychology #ai #DreamCoach #lucidream #jung #freud #mindfulness');
  } else {
    lines.push('#חלומות #פירוש #שינה #פסיכולוגיה #AI #DreamCoach #יוונג #פרויד #מודעות');
  }
  return lines.join('\n');
}

/**
 * Main entry. Returns a summary object; never throws (errors logged to
 * schedulerLogs).
 *
 * @param {Object}  [opts]
 * @param {'scheduled'|'manual'} [opts.trigger='scheduled']
 * @param {string}  [opts.themeId]   force a specific theme instead of day-of-week
 */
async function postDreamCoachCarousel({ trigger = 'scheduled', themeId, language } = {}) {
  const lang = language === 'en' ? 'en' : 'he';
  const runId = `${Date.now()}-carousel-${lang}`;
  const logRef = db.collection('social_posts').doc(runId);
  await logRef.set({
    runId,
    site: 'dream-analytics',
    videoType: `carousel_${lang}`,
    slot: trigger === 'scheduled' ? 'morning' : 'manual',
    trigger,
    type: 'dreamcoach_carousel',
    language: lang,
    themeId: themeId || null,
    status: 'started',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  try {
    // 1. Generate the daily content.
    await loadGeminiSDK();
    const { GoogleGenAI } = getGeminiSDK();
    const genAI =
      GoogleGenAI && process.env.GEMINI_API_KEY
        ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
        : null;

    const content = await buildDreamCoachContent(genAI, { themeId, language: lang });
    logger.info(
      `[dreamCoachCarousel] theme=${content.theme.id} items=${content.items.length}`
    );
    await logRef.update({
      status: 'rendering',
      themeId: content.theme.id,
      themeHeadline: content.theme.headline,
    });

    // 2. Render all slides (Nano Banana backgrounds + Remotion).
    const slideUrls = await buildDreamCoachSlideUrls(content);
    logger.info(`[dreamCoachCarousel] rendered ${slideUrls.length} slides`);

    await logRef.update({ status: 'creating_containers', slideUrls });

    // 3. If IG isn't configured yet, stop here and log a preview-only success.
    const igConfigured = !!(getIgUserId() && getIgToken());
    if (!igConfigured) {
      const note =
        'DREAM_IG_USER_ID and/or DREAM_IG_ACCESS_TOKEN are not set — skipping publish. Slide URLs are stored in this log so you can preview the design.';
      logger.warn('[dreamCoachCarousel] ' + note);
      await logRef.update({
        status: 'success',
        previewOnly: true,
        note,
        slideUrls,
        completedAt: new Date().toISOString(),
      });
      return { success: true, previewOnly: true, slideUrls, runId };
    }

    // 4. Create IG child containers sequentially (parallel sometimes 429s).
    const childIds = [];
    for (const url of slideUrls) {
      childIds.push(await createIgChild(url));
    }

    await logRef.update({ status: 'publishing' });

    // 5. Carousel parent + publish.
    const caption = buildCaption(content);
    const mediaId = await publishCarousel(childIds, caption);

    await logRef.update({
      status: 'success',
      mediaId,
      caption,
      completedAt: new Date().toISOString(),
    });
    logger.info(`[dreamCoachCarousel] PUBLISHED media id=${mediaId}`);
    return { success: true, mediaId, slideUrls, runId };
  } catch (err) {
    logger.error('[dreamCoachCarousel] FAILED:', err);
    await logRef.update({
      status: 'error',
      error: err.message || String(err),
      completedAt: new Date().toISOString(),
    });
    return { success: false, error: err.message || String(err), runId };
  }
}

module.exports = { postDreamCoachCarousel };
