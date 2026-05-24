/**
 * dreamCharacterPipeline.js
 * ---------------------------------------------------------------------------
 * Generates a 50-second vertical "AI character" dream video for DreamCoach.
 *
 * Flow:
 *   1. Gemini writes a fresh script in the requested language (he/en) using
 *      one of 6 character archetypes (rotates randomly unless caller pins it).
 *   2. Veo 3.1 Fast produces three short SILENT character/dream clips
 *      (~$1-2 of Veo budget total per video, vs ~$25 with Veo 3.1 Pro).
 *   3. TTS turns the dreamer dialogue + DreamCoach AI interpretation into
 *      MP3s — Google Cloud TTS for Hebrew, ElevenLabs for English.
 *   4. Remotion Lambda composes the final MP4 (`DreamCharacterVideo`),
 *      stitching Veo footage + voice tracks + Remotion-native AI orb scene
 *      + brand CTA card.
 *   5. Persists the run to `social_posts` so the existing Live Tracker /
 *      Post History UI on social-dashboard.html shows it like any other
 *      pipeline.
 *
 * Manual trigger only — exported as `triggerDreamCharacterVideo` (onRequest
 * with `x-admin-key`). No cron.
 */

const admin = require('firebase-admin');
const axios = require('axios');
const fetch = require('node-fetch');
const { renderMediaOnLambda, getRenderProgress } = require('@remotion/lambda/client');
const { logger } = require('firebase-functions');

const { loadGeminiSDK, getGeminiSDK } = require('./services/_genaiUtils');
const { buildCharacterScript } = require('./services/dreamCharacterContent');
// Reuse the existing ambient-music generator. Each call rotates through a
// varied prompt pool with a seed so consecutive runs sound different.
const { generateDreamAmbient } = require('./services/characterAmbient');
// Reuse the IG + YT uploaders from the main dream video pipeline so we keep
// auth, polling, and refresh-token logic in one place.
const { uploadToInstagram, uploadToYouTube } = require('./dreamVideoPipeline');

// ── Constants (match the values used by dreamVideoPipeline.js) ─────────────
const GCP_PROJECT = 'dreamanalysis-39322';
const BUCKET      = `${GCP_PROJECT}.firebasestorage.app`;
const VEO_FAST_MODEL = 'veo-3.1-fast-generate-001';
const REMOTION_REGION   = 'us-east-1';
const REMOTION_FUNCTION = () => (process.env.DREAM_REMOTION_FUNCTION_NAME || 'remotion-render-4-0-452-mem3008mb-disk2048mb-900sec').trim();
const REMOTION_SERVE_URL = () => (process.env.DREAM_REMOTION_SERVE_URL || '').trim();
const S3_BUCKET_FOR_PROXY = 'remotionlambda-useast1-di0xuqpokc';   // same Remotion bucket
const S3_REGION = 'us-east-1';

function trimAwsCreds() {
  if (process.env.REMOTION_AWS_ACCESS_KEY_ID) {
    process.env.REMOTION_AWS_ACCESS_KEY_ID = process.env.REMOTION_AWS_ACCESS_KEY_ID.trim();
  }
  if (process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
    process.env.REMOTION_AWS_SECRET_ACCESS_KEY = process.env.REMOTION_AWS_SECRET_ACCESS_KEY.trim();
  }
}

async function getVertexToken() {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

// ── Gemini client (uses GEMINI_API_KEY from .env) ──────────────────────────
async function getGenAI() {
  if (!process.env.GEMINI_API_KEY) return null;
  await loadGeminiSDK();
  const { GoogleGenAI } = getGeminiSDK();
  if (!GoogleGenAI) return null;
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

// ── Copy a Veo GCS clip into the Remotion S3 bucket (same region as Lambda) ─
async function copyVideoToS3(publicUrl, s3Key) {
  trimAwsCreds();
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: process.env.REMOTION_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.REMOTION_AWS_SECRET_ACCESS_KEY,
    },
  });
  const res = await fetch(publicUrl, { timeout: 60000 });
  if (!res.ok) throw new Error(`copyVideoToS3 download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await client.send(new PutObjectCommand({
    Bucket: S3_BUCKET_FOR_PROXY,
    Key: s3Key,
    Body: buf,
    ContentType: 'video/mp4',
    ACL: 'public-read',
  }));
  return `https://${S3_BUCKET_FOR_PROXY}.s3.${S3_REGION}.amazonaws.com/${s3Key}`;
}

// ── Veo 3.1 Fast wrapper that ALLOWS people (opposite of the existing abstract helper) ──
async function generateCharacterScene(prompt, sceneKey) {
  try {
    const token = await getVertexToken();
    const endpoint = `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${VEO_FAST_MODEL}:predictLongRunning`;
    const body = {
      instances: [{
        prompt,
        negativePrompt: 'text overlay, watermark, logo, deformed, extra limbs, distorted face, unrealistic',
      }],
      parameters: {
        aspectRatio: '9:16',
        sampleCount: 1,
        durationSeconds: 8,
        personGeneration: 'allow_adult',    // characters allowed (vs. abstract dreamscapes which forbid)
        storageUri: `gs://${BUCKET}/dream-character-veo/`,
      },
    };
    const initRes = await axios.post(endpoint, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 60000,
    });
    const operationName = initRes.data?.name;
    if (!operationName) throw new Error('Veo Fast returned no operation name');
    logger.info(`[dreamCharacter] Veo Fast (${sceneKey}) op: ${operationName}`);

    const fetchOpEndpoint =
      `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${VEO_FAST_MODEL}:fetchPredictOperation`;

    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(r => setTimeout(r, 15000));
      const pollToken = await getVertexToken();
      const pollRes = await axios.post(
        fetchOpEndpoint,
        { operationName },
        { headers: { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      if (!pollRes.data.done) continue;

      const predictions = pollRes.data.response?.predictions;
      const videoEntry = Array.isArray(predictions) && predictions[0];
      let gcsUri = videoEntry?.video?.uri || videoEntry?.gcsUri || videoEntry?.uri;
      if (!gcsUri) {
        const videos = pollRes.data.response?.videos || pollRes.data.metadata?.videos;
        gcsUri = Array.isArray(videos) && (videos[0]?.gcsUri || videos[0]?.uri);
      }
      if (!gcsUri) {
        logger.warn(`[dreamCharacter] Veo Fast done but no URI for ${sceneKey}:`, JSON.stringify(pollRes.data).slice(0, 400));
        return '';
      }
      if (gcsUri.startsWith('gs://')) {
        try {
          const bucketName = gcsUri.split('/')[2];
          const objectPath = gcsUri.split('/').slice(3).join('/');
          await admin.storage().bucket(bucketName).file(objectPath).makePublic();
        } catch (e) { /* best effort */ }
      }
      const gcsPublicUrl = gcsUri.startsWith('gs://')
        ? gcsUri.replace('gs://', 'https://storage.googleapis.com/')
        : gcsUri;

      // Copy to S3 (Remotion Lambda same region, much faster fetch).
      const s3Key = `dream-character-clips/${Date.now()}-${sceneKey}.mp4`;
      const finalUrl = await copyVideoToS3(gcsPublicUrl, s3Key);
      logger.info(`[dreamCharacter] Veo Fast (${sceneKey}) → ${finalUrl}`);
      return finalUrl;
    }
    logger.warn(`[dreamCharacter] Veo Fast (${sceneKey}) timed out`);
    return '';
  } catch (err) {
    logger.warn(`[dreamCharacter] Veo Fast (${sceneKey}) failed:`, err.message);
    return '';
  }
}

// ── Per-scene Veo prompts (use the archetype's veoDescription for consistency) ─
function characterPrompts(archetype, dream) {
  const who = archetype.veoDescription;
  const dreamImagery = (dream && dream.imagery) || 'surreal dreamscape with violet glow';
  return {
    speaking:
      `Cinematic close-up portrait shot, 9:16 vertical. ${who}. ` +
      `She/he is talking softly toward camera with thoughtful expression, gentle natural mouth movement (no audible dialog), ` +
      `slow shallow head motion, warm bedroom light, soft bokeh background of pillows and lamp, ` +
      `subtle film grain, photoreal, premium documentary-portrait style. Camera locked, eye contact.`,
    sleeping:
      `Cinematic medium shot, 9:16 vertical. ${who}, lying on back asleep on a soft cotton pillow, ` +
      `eyelids gently fluttering as if in REM, mouth softly parted, breathing slow and rhythmic, ` +
      `moonlight falling across the face, dreamy purple haze in the air, slow zoom-in, photoreal.`,
    dream:
      `Surreal cinematic dreamscape, 9:16 vertical, abstract symbolic imagery inspired by: "${dreamImagery}". ` +
      `Style: dreamlike slow motion, deep violet and gold light particles, floating mist, glowing thresholds, ` +
      `cosmic premium aesthetic. NO humans, NO faces, NO figures. Pure abstract imagery, ethereal atmosphere.`,
  };
}

// ── Caption + title builder ────────────────────────────────────────────────
// Builds platform-ready text from the Gemini script + dream summary so YT
// gets a real SEO-friendly title/description and IG gets a hook caption.
function buildCaptions({ script, language }) {
  const dreamLine =
    script.scripts.openingHook ||
    (language === 'he' ? 'חלום שביקר אותי הלילה' : 'A dream that visited me last night');
  const interp = script.scripts.coachInterpretation || '';
  const cta    = script.scripts.cta || '';

  if (language === 'he') {
    return {
      ytTitle: `${dreamLine} 🌙 פירוש חלום מבוסס AI`.slice(0, 100),
      ytDescription:
        `${interp}\n\n` +
        `🌙 הניתוח המלא נעשה ע״י DreamCoach AI — שילוב של פסיכולוגיה יונגיאנית, פרוידיאנית וגשטלט.\n` +
        `👉 פענחו חלום משלכם ב-dream-analytics.com/he/\n\n` +
        `#DreamCoach #חלומות #פירושחלום #שינה #פסיכולוגיה #יונג #פרויד #AI`,
      ytTags: ['חלומות', 'פירוש חלום', 'DreamCoach', 'פסיכולוגיה', 'יונג', 'שינה', 'AI'],
      igCaption:
        `${dreamLine} 🌙\n\n` +
        `${interp}\n\n` +
        `${cta}\n` +
        `🔗 קישור בביו → dream-analytics.com/he/\n\n` +
        `#DreamCoach #חלומות #פירוש #שינה #פסיכולוגיה #יונג #פרויד`,
    };
  }
  return {
    ytTitle: `${dreamLine} 🌙 An AI Dream Interpretation`.slice(0, 100),
    ytDescription:
      `${interp}\n\n` +
      `🌙 Interpretation by DreamCoach AI — blending Jungian, Freudian and Gestalt frameworks.\n` +
      `👉 Decode your own dream at dream-analytics.com\n\n` +
      `#DreamCoach #Dreams #DreamInterpretation #SleepScience #Jung #Freud #LucidDream #AI`,
    ytTags: ['DreamCoach', 'dreams', 'dream interpretation', 'jung', 'freud', 'sleep', 'lucid dream', 'AI'],
    igCaption:
      `${dreamLine} 🌙\n\n` +
      `${interp}\n\n` +
      `${cta}\n` +
      `🔗 Link in bio → dream-analytics.com\n\n` +
      `#DreamCoach #Dreams #DreamInterpretation #LucidDream #SleepScience #Jung #Freud`,
  };
}

// ── Main entry ─────────────────────────────────────────────────────────────
/**
 * @param {Object}  [opts]
 * @param {'he'|'en'} [opts.language='he']
 * @param {string}  [opts.archetypeId]
 * @param {'manual'} [opts.trigger='manual']
 */
async function postDreamCharacterVideo({ trigger = 'manual', language = 'he', archetypeId } = {}) {
  const lang = language === 'en' ? 'en' : 'he';
  const runId = `${Date.now()}-character-${lang}`;
  const logRef = admin.firestore().collection('social_posts').doc(runId);
  await logRef.set({
    runId,
    site: 'dream-analytics',
    videoType: `character_${lang}`,
    type: 'dream_character_video',
    trigger,
    language: lang,
    slot: 'manual',
    status: 'started',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  try {
    // ── 1. Script via Gemini ─────────────────────────────────────────────
    const genAI = await getGenAI();
    const script = await buildCharacterScript(genAI, { language: lang, archetypeId });
    logger.info(`[dreamCharacter] archetype=${script.archetype.id} lang=${lang}`);
    await logRef.update({
      status: 'script_ready',
      archetype: script.archetype.id,
      script,
      updatedAt: new Date().toISOString(),
    });

    // ── 2. Veo Fast clips (parallel) ─────────────────────────────────────
    const prompts = characterPrompts(script.archetype, script.dream);
    await logRef.update({ status: 'rendering_veo', updatedAt: new Date().toISOString() });
    const [characterSpeakingUrl, characterDreamingUrl, dreamVisualUrl] = await Promise.all([
      generateCharacterScene(prompts.speaking, 'speaking'),
      generateCharacterScene(prompts.sleeping, 'sleeping'),
      generateCharacterScene(prompts.dream,    'dream'),
    ]);

    await logRef.update({
      status: 'veo_done',
      veoClips: { characterSpeakingUrl, characterDreamingUrl, dreamVisualUrl },
      updatedAt: new Date().toISOString(),
    });

    // ── 3. Ambient music (replaces TTS — varied per run) ─────────────────
    // Calming + mysterious dreamlike track that plays under the entire video.
    // The prompt and a randomised mood seed are picked fresh each run so no
    // two videos sound identical.
    await logRef.update({ status: 'rendering_ambient', updatedAt: new Date().toISOString() });
    const ambientAudioUrl = await generateDreamAmbient({ runId });
    await logRef.update({
      status: 'ambient_done',
      audio: { ambientAudioUrl },
      updatedAt: new Date().toISOString(),
    });

    // ── 4. Remotion Lambda render ────────────────────────────────────────
    trimAwsCreds();
    const serveUrl = REMOTION_SERVE_URL();
    if (!serveUrl) throw new Error('DREAM_REMOTION_SERVE_URL not set');
    await logRef.update({ status: 'rendering_remotion', updatedAt: new Date().toISOString() });

    const inputProps = {
      characterDreamingUrl: characterDreamingUrl || undefined,
      dreamVisualUrl: dreamVisualUrl || undefined,
      characterSpeakingUrl: characterSpeakingUrl || undefined,
      ambientAudioUrl: ambientAudioUrl || undefined,
      hebrew: lang === 'he',
      openingHook: script.scripts.openingHook,
      dreamNarration: script.scripts.dreamNarration,
      coachInterpretation: script.scripts.coachInterpretation,
      cta: script.scripts.cta,
      themeColor: '#7C3AED',
    };

    const init = await renderMediaOnLambda({
      region: REMOTION_REGION,
      functionName: REMOTION_FUNCTION(),
      serveUrl,
      composition: 'DreamCharacterVideo',
      inputProps,
      codec: 'h264',
      imageFormat: 'jpeg',
      privacy: 'public',
      framesPerLambda: 1500,            // single-shot — avoids concurrency limits
      maxRetries: 1,
    });

    // Poll
    let result = null;
    for (let i = 0; i < 90; i++) {     // up to 15 min
      await new Promise((r) => setTimeout(r, 10000));
      const p = await getRenderProgress({
        renderId: init.renderId,
        bucketName: init.bucketName,
        functionName: REMOTION_FUNCTION(),
        region: REMOTION_REGION,
      });
      if (p.done) { result = p; break; }
      if (p.fatalErrorEncountered) {
        throw new Error(`Remotion render failed: ${JSON.stringify(p.errors).slice(0, 400)}`);
      }
    }
    if (!result) throw new Error('Remotion polling timed out');
    const videoUrl = result.outputFile || result.outUrl || '';
    if (!videoUrl) throw new Error('Remotion returned no output URL');

    await logRef.update({
      status: 'rendered',
      videoUrl,
      veoClips: { characterSpeakingUrl, characterDreamingUrl, dreamVisualUrl },
      audio: { ambientAudioUrl },
      updatedAt: new Date().toISOString(),
    });

    // ── 5. Publish to YouTube + Instagram (independent — one can fail) ───
    const results = { youtube: null, instagram: null };
    const captions = buildCaptions({ script, language: lang });

    try {
      results.youtube = await uploadToYouTube({
        videoUrl,
        title: captions.ytTitle,
        description: captions.ytDescription,
        tags: captions.ytTags,
      });
      logger.info(`[dreamCharacter] YouTube: ${results.youtube.url}`);
    } catch (e) {
      logger.error('[dreamCharacter] YouTube upload failed:', e.message);
      results.youtube = { error: e.message };
    }

    try {
      results.instagram = await uploadToInstagram(videoUrl, captions.igCaption);
      logger.info(`[dreamCharacter] Instagram: ${results.instagram.url}`);
    } catch (e) {
      logger.error('[dreamCharacter] Instagram upload failed:', e.message);
      results.instagram = { error: e.message };
    }

    await logRef.update({
      status: 'success',
      results,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    logger.info(`[dreamCharacter] SUCCESS lang=${lang} runId=${runId} url=${videoUrl}`);
    return { success: true, runId, videoUrl, script };
  } catch (err) {
    logger.error('[dreamCharacter] FAILED:', err);
    await logRef.update({
      status: 'error',
      error: err.message || String(err),
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { success: false, runId, error: err.message || String(err) };
  }
}

module.exports = { postDreamCharacterVideo };
