/**
 * ttsService.js
 * ---------------------------------------------------------------------------
 * Routes text-to-speech calls per user spec:
 *   - Hebrew (he-IL) → Google Cloud Text-to-Speech (Chirp 3 / WaveNet voices)
 *   - English (en-US) → ElevenLabs Multilingual v2
 *
 * Returns a public Firebase Storage URL to the resulting MP3 so Remotion
 * Lambda can fetch it during render.
 *
 * Public API:
 *   synthesizeSpeech({ text, language, role, runId, sceneKey }) → public URL
 *
 * `role` picks a voice persona:
 *   - 'dreamer'  → young/feeling voice, used for the character narrating their dream
 *   - 'coach'    → warm authoritative therapist voice, used for the DreamCoach AI
 *
 * Never throws — returns empty string on failure (video will play silent).
 */

const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('firebase-functions');

const BUCKET = `${process.env.GCLOUD_PROJECT || 'dreamanalysis-39322'}.firebasestorage.app`;

// ─── Voice mappings ────────────────────────────────────────────────────────
// Google TTS — Hebrew Chirp 3 HD voices are the highest quality. Keep two so
// scenes can sound distinct.
const GOOGLE_HE_VOICES = {
  dreamer: { name: 'he-IL-Chirp3-HD-Aoede',   languageCode: 'he-IL' },  // warm female
  coach:   { name: 'he-IL-Chirp3-HD-Charon',  languageCode: 'he-IL' },  // calm male
};

// ElevenLabs — Multilingual v2. Two public voice IDs from the ElevenLabs
// default library. They can be swapped via env if you want custom-cloned ones.
const ELEVENLABS_EN_VOICES = {
  dreamer: process.env.ELEVENLABS_VOICE_DREAMER_EN || 'EXAVITQu4vr4xnSDxMaL', // Sarah, warm female
  coach:   process.env.ELEVENLABS_VOICE_COACH_EN   || 'pNInz6obpgDQGcFmaJgB', // Adam, calm male
};

// ─── Helpers ───────────────────────────────────────────────────────────────
async function getVertexToken() {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function uploadMp3({ buf, runId, sceneKey }) {
  const bucket = admin.storage().bucket(BUCKET);
  const dest = `dream-character/${runId}/${sceneKey}_${uuidv4().slice(0, 6)}.mp3`;
  const file = bucket.file(dest);
  await file.save(buf, {
    contentType: 'audio/mpeg',
    resumable: false,
    public: true,
    metadata: { cacheControl: 'public, max-age=86400' },
  });
  try { await file.makePublic(); } catch (_) {}
  return `https://storage.googleapis.com/${BUCKET}/${dest}`;
}

// ─── Google Cloud TTS (Hebrew) ─────────────────────────────────────────────
async function ttsGoogle(text, role, runId, sceneKey) {
  try {
    const voice = GOOGLE_HE_VOICES[role] || GOOGLE_HE_VOICES.dreamer;
    const token = await getVertexToken();
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: voice.languageCode, name: voice.name },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 0.95,        // slightly slower = clearer in HE
          pitch: 0,
          sampleRateHertz: 24000,
        },
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.warn(`Google TTS ${res.status}: ${txt.slice(0, 300)}`);
      return '';
    }
    const data = await res.json();
    if (!data.audioContent) {
      logger.warn('Google TTS returned no audioContent');
      return '';
    }
    const buf = Buffer.from(data.audioContent, 'base64');
    return uploadMp3({ buf, runId, sceneKey });
  } catch (err) {
    logger.warn('ttsGoogle failed:', err.message);
    return '';
  }
}

// ─── ElevenLabs (English) ──────────────────────────────────────────────────
async function ttsElevenLabs(text, role, runId, sceneKey) {
  const apiKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!apiKey) {
    logger.warn('ttsElevenLabs: ELEVENLABS_API_KEY not set');
    return '';
  }
  try {
    const voiceId = ELEVENLABS_EN_VOICES[role] || ELEVENLABS_EN_VOICES.dreamer;
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
        }),
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logger.warn(`ElevenLabs TTS ${res.status}: ${txt.slice(0, 300)}`);
      return '';
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return uploadMp3({ buf, runId, sceneKey });
  } catch (err) {
    logger.warn('ttsElevenLabs failed:', err.message);
    return '';
  }
}

/**
 * Public entry. Picks the right provider based on language.
 * @returns public HTTPS URL (or '' on failure)
 */
async function synthesizeSpeech({ text, language, role, runId, sceneKey }) {
  if (!text || !text.trim()) return '';
  const t = String(text).trim().slice(0, 1500);
  if (language === 'he') return ttsGoogle(t, role, runId, sceneKey);
  return ttsElevenLabs(t, role, runId, sceneKey);
}

module.exports = { synthesizeSpeech };
