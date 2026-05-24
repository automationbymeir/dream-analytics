/**
 * characterAmbient.js
 * ---------------------------------------------------------------------------
 * Generates a fresh ambient track per DreamCoach AI-character video.
 *
 * Uses ElevenLabs Sound Effects (`/v1/sound-generation`, already in use
 * elsewhere in this project). Picks a varied prompt each call so consecutive
 * videos sound different, with an additional randomised seed phrase mixed in
 * so even repeated picks from the pool are sonically distinct.
 *
 * Returns a public URL to the MP3 (uploaded to Firebase Storage) or ''
 * on failure — the video keeps rendering silent if so.
 */

const admin = require('firebase-admin');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('firebase-functions');

const BUCKET = `${process.env.GCLOUD_PROJECT || 'dreamanalysis-39322'}.firebasestorage.app`;

// Calming + mysterious dreamlike prompts. Each video randomly picks one and
// receives an extra "mood seed" appended so the model produces fresh output.
const PROMPTS = [
  'Slow ambient dreamlike soundscape: soft piano notes drifting through a cosmic mist, subtle synth pads, deep breathing space. Calming and mysterious. No vocals, no melody hooks.',
  'Mystical lullaby ambient: distant chimes, slow analog synth swells, soft heartbeat pulse, gentle reverb tail. Meditative and otherworldly. No vocals.',
  'Ethereal nocturnal ambient: glassy bells reflecting in deep space, smooth low-end pad, occasional shimmering pluck. Calm hypnotic mystery. No vocals.',
  'Calming dream therapy soundscape: warm felt-piano arpeggios drifting, soft choir-like pad in the background, distant whale-song reverb. Peaceful and mysterious. No vocals.',
  'Subliminal night journey: deep airy drone, soft white noise wash, occasional glimmering harp note, gentle subterranean rumble. Hypnotic and mysterious. No vocals.',
  'Slow lunar meditation: silver-toned bells, smooth wavy synth pad, breathy flute texture, gentle cosmic glide. Mystical and serene. No vocals.',
  'Underwater dream cave: distant sonar pulses, glassy chimes, soft echo of liquid drops, deep oceanic pad. Mysterious and tranquil. No vocals.',
  'Ancient ritual mystic ambient: low sustained chant-like drone (wordless), bone flute hint, soft wind, sparkly star textures. Mysterious calm. No vocals.',
  'Twilight forest dream: distant owl-call texture, soft wind through pines, gentle silver shimmer, slow ambient pad. Calming and mysterious. No vocals.',
  'Cosmic memory chamber: time-stretched piano, slow reversed bell echoes, smooth low pad, deep tranquil mystery. No vocals.',
];

const MOOD_SEEDS = [
  'with a slight golden undertone',
  'with whispers of violet starlight',
  'with a faint silver shimmer',
  'with a slow tidal breathing rhythm',
  'with a dim crystalline resonance',
  'with a hushed forest depth',
  'with a soft moonlit glaze',
  'with a gentle nebula drift',
];

/**
 * Generate one ~22s ambient track and return its public URL.
 * Looped seamlessly on the Remotion side via <LoopingAudio>.
 *
 * @param {object} opts
 * @param {string} opts.runId        used for the destination filename
 * @returns {Promise<string>}
 */
async function generateDreamAmbient({ runId } = {}) {
  const xiKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!xiKey) {
    logger.warn('characterAmbient: ELEVENLABS_API_KEY not set — video will be silent');
    return '';
  }
  const basePrompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  const mood       = MOOD_SEEDS[Math.floor(Math.random() * MOOD_SEEDS.length)];
  const prompt     = `${basePrompt} ${mood}`;
  try {
    logger.info(`[characterAmbient] generating: "${prompt.slice(0, 120)}…"`);
    const res = await axios.post(
      'https://api.elevenlabs.io/v1/sound-generation',
      {
        text: prompt,
        duration_seconds: 22,
        prompt_influence: 0.5,
      },
      {
        headers: { 'xi-api-key': xiKey, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 90_000,
      }
    );
    const bucket = admin.storage().bucket(BUCKET);
    const dest = `dream-character/${runId || 'misc'}/ambient_${uuidv4().slice(0, 6)}.mp3`;
    const file = bucket.file(dest);
    await file.save(Buffer.from(res.data), {
      contentType: 'audio/mpeg',
      resumable: false,
      public: true,
      metadata: { cacheControl: 'public, max-age=86400' },
    });
    try { await file.makePublic(); } catch (_) {}
    const url = `https://storage.googleapis.com/${BUCKET}/${dest}`;
    logger.info(`[characterAmbient] ready: ${url}`);
    return url;
  } catch (err) {
    const msg = err.response?.data?.toString?.()?.slice?.(0, 240) || err.message;
    logger.warn('characterAmbient failed:', msg);
    return '';
  }
}

module.exports = { generateDreamAmbient };
