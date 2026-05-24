/**
 * dreamCharacterContent.js
 * ---------------------------------------------------------------------------
 * Gemini-driven script generator for the "dream character" videos.
 *
 * Each run picks (or accepts) one CHARACTER ARCHETYPE, then has Gemini
 * write a full bilingual-aware script in the requested language using the
 * DreamCoach interpretation formula (Jungian + Freudian/Gestalt + Reflection).
 *
 * The character archetypes rotate so consecutive videos feel varied. Each
 * archetype carries a physical description that we feed straight into Veo's
 * scene prompts so the same person appears across the 3 character scenes.
 *
 * Public API:
 *   buildCharacterScript(genAI, { language, archetypeId? }) → {
 *     archetype: { id, label, veoDescription },
 *     dream: { imagery, symbols[] },
 *     scripts: {
 *       openingHook: string,      // 1 short line that flashes on intro
 *       dreamNarration: string,   // what the character says (scene 3)
 *       coachInterpretation: string, // what DreamCoach AI says (scene 4)
 *       cta: string,              // closing line
 *     },
 *     language: 'he' | 'en',
 *   }
 *
 * Never throws — falls back to a hand-written script on Gemini failure.
 */

const { logger } = require('firebase-functions');

// ─── 6 character archetypes ────────────────────────────────────────────────
// Each `veoDescription` is a SHORT visual-only prompt fragment so Veo can
// produce a consistent character across scenes without needing image conditioning.
const ARCHETYPES = [
  {
    id: 'young-woman-creative',
    label: 'Young creative woman (late 20s)',
    veoDescription:
      'A young woman in her late 20s with shoulder-length dark wavy hair, warm olive skin, expressive almond brown eyes, wearing a soft cream linen pyjama top, gentle natural makeup, calm thoughtful expression',
  },
  {
    id: 'middle-aged-man-thoughtful',
    label: 'Middle-aged thoughtful man (mid 40s)',
    veoDescription:
      'A middle-aged man in his mid 40s with short salt-and-pepper hair, warm hazel eyes, light stubble, wearing a faded heather grey crew-neck t-shirt, calm reflective expression, soft laugh-lines',
  },
  {
    id: 'teen-girl-curious',
    label: 'Curious teenage girl (16-17)',
    veoDescription:
      'A teenage girl around 16, light freckles across her cheeks, bright curious eyes, long auburn hair tied loosely back, wearing a faded pastel pink hoodie, fresh-faced no makeup, gentle inquisitive expression',
  },
  {
    id: 'elderly-woman-warm',
    label: 'Warm elderly woman (early 70s)',
    veoDescription:
      'An elderly woman in her early 70s with soft silver-white hair pulled back, kind crinkled blue eyes, warm wrinkled smile lines, wearing a knit lavender cardigan, serene grandmotherly presence',
  },
  {
    id: 'young-man-introspective',
    label: 'Introspective young man (early 30s)',
    veoDescription:
      'A young man in his early 30s with neatly cropped brown hair, soft hazel-green eyes, light five-o-clock shadow, wearing a dark navy henley shirt, calm introspective expression',
  },
  {
    id: 'middle-eastern-woman-mother',
    label: 'Middle Eastern mother (mid 30s)',
    veoDescription:
      'A Middle-Eastern woman in her mid 30s with long dark hair, warm tan skin, expressive deep brown eyes, wearing a soft mauve nightshirt, gentle nurturing expression, single thin gold chain necklace',
  },
];

function pickArchetype(archetypeId) {
  if (archetypeId) {
    const match = ARCHETYPES.find((a) => a.id === archetypeId);
    if (match) return match;
  }
  return ARCHETYPES[Math.floor(Math.random() * ARCHETYPES.length)];
}

// ─── Fallback (used when Gemini is unavailable) ───────────────────────────
function fallbackScript(archetype, language) {
  if (language === 'en') {
    return {
      archetype,
      dream: {
        imagery: 'walking through an empty house with one glowing door at the end of the hallway',
        symbols: ['empty house', 'glowing door', 'hallway', 'silence'],
      },
      scripts: {
        openingHook: 'Last night a dream visited me...',
        dreamNarration:
          'I was walking through an empty house. Every room I passed was silent. At the end of the hallway one door was glowing, and I just stood there — wanting to open it but unable to move.',
        coachInterpretation:
          'The empty house mirrors a part of your psyche you are quietly revisiting. The glowing door is a Jungian threshold — an invitation toward something new. The stillness suggests readiness, not avoidance. Reflection: what door in your waking life are you standing in front of right now?',
        cta: 'Open DreamCoach to decode your own dream tonight.',
      },
      language,
    };
  }
  return {
    archetype,
    dream: {
      imagery: 'הליכה בבית ריק עם דלת זוהרת אחת בקצה המסדרון',
      symbols: ['בית ריק', 'דלת זוהרת', 'מסדרון', 'שקט'],
    },
    scripts: {
      openingHook: 'בלילה שעבר חלום ביקר אותי…',
      dreamNarration:
        'הלכתי בתוך בית ריק. כל חדר שעברתי בו היה שקט לחלוטין. בקצה המסדרון דלת אחת זהרה, ואני פשוט עמדתי שם — רציתי לפתוח אותה אבל לא יכולתי לזוז.',
      coachInterpretation:
        'הבית הריק משקף חלק מהנפש שאת/ה חוזר/ת אליו בשקט. הדלת הזוהרת היא סף יונגיאני — הזמנה למשהו חדש. הדממה מסמנת מוכנות, לא הימנעות. שאלת התבוננות: באיזו דלת בחיים הערים את/ה ניצב/ת עכשיו?',
      cta: 'פתחו את DreamCoach וגלו את משמעות החלום שלכם הלילה.',
    },
    language,
  };
}

// ─── Public ────────────────────────────────────────────────────────────────
async function buildCharacterScript(genAI, { language, archetypeId } = {}) {
  const lang = language === 'en' ? 'en' : 'he';
  const archetype = pickArchetype(archetypeId);

  if (!genAI) {
    logger.warn('dreamCharacterContent: Gemini unavailable — using fallback');
    return fallbackScript(archetype, lang);
  }

  const inLang = lang === 'en' ? 'English' : 'Hebrew (כתיב מלא, עברית רהוטה)';
  const formulaReminder =
    lang === 'en'
      ? `Apply the DreamCoach interpretation formula:
1. Jungian analysis — name the archetype/symbol and what it tends to surface from the unconscious.
2. One short alternative angle (Freudian or Gestalt).
3. End with ONE reflection question addressed to the dreamer.
Voice: warm, intelligent, evidence-based therapist. No new-age clichés. No "the universe wants you to…". No horoscopes.`
      : `יישם את הנוסחה של DreamCoach לפירוש חלומות:
1. ניתוח יונגיאני — נקוב את הסמל/הארכיטיפ ומה הוא לרוב מעלה מהלא-מודע.
2. זווית חלופית קצרה (פרוידיאנית או גשטלט).
3. סיים בשאלת התבוננות אחת לחולם/ת.
טון: חם, אינטליגנטי, מבוסס-פסיכולוגיה. בלי קלישאות ניו-אייג'. בלי "היקום רוצה ש…". בלי הורוסקופים.`;

  const prompt = `You're writing a 50-second short video script for DreamCoach, an AI dream analysis app.

CHARACTER (visual reference only, do NOT mention their appearance in the script):
${archetype.label} — ${archetype.veoDescription}

LANGUAGE: write the script in ${inLang}. All five fields below must be in that language.

${formulaReminder}

Generate ONE dream and the matching narrative. Pick a fresh, varied dream image — avoid clichés like teeth falling out or being naked. Make the symbol meaningful (a chase, a vanished room, a flooded street, a child you've never seen, a letter that won't open, etc.).

Return JSON ONLY in this exact shape (no markdown):
{
  "dreamImagery": "1 sentence describing the visual scene of the dream (used by an image generator, so be concrete)",
  "dreamSymbols": ["2-4 single-word or short-phrase symbols"],
  "openingHook": "1 short opening line the character says in voiceover at the start (≤12 words, hook the viewer)",
  "dreamNarration": "what the character tells us about their dream — natural spoken voice, 2-3 sentences, 35-55 words",
  "coachInterpretation": "the DreamCoach AI's interpretation following the formula above — 3-4 sentences, 55-85 words, end with a reflection question",
  "cta": "a punchy closing line that invites viewers to open DreamCoach (≤12 words)"
}`;

  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const raw = (typeof result.text === 'function' ? result.text() : result.text) || '';
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) {
      logger.warn('dreamCharacterContent: no JSON in response, using fallback');
      return fallbackScript(archetype, lang);
    }
    const parsed = JSON.parse(m[0]);
    if (
      !parsed.dreamNarration ||
      !parsed.coachInterpretation ||
      !parsed.openingHook
    ) {
      logger.warn('dreamCharacterContent: missing required fields, using fallback');
      return fallbackScript(archetype, lang);
    }
    return {
      archetype,
      dream: {
        imagery: String(parsed.dreamImagery || '').trim(),
        symbols: Array.isArray(parsed.dreamSymbols) ? parsed.dreamSymbols.slice(0, 4) : [],
      },
      scripts: {
        openingHook: String(parsed.openingHook).trim(),
        dreamNarration: String(parsed.dreamNarration).trim(),
        coachInterpretation: String(parsed.coachInterpretation).trim(),
        cta: String(parsed.cta || '').trim() ||
          (lang === 'en' ? 'Open DreamCoach to decode your own dream.' : 'פתחו את DreamCoach לפענוח החלום שלכם.'),
      },
      language: lang,
    };
  } catch (err) {
    logger.warn('dreamCharacterContent failed:', err.message);
    return fallbackScript(archetype, lang);
  }
}

module.exports = { buildCharacterScript, ARCHETYPES };
