/**
 * dreamCoachContent.js
 * ---------------------------------------------------------------------------
 * Generates Hebrew content for DreamCoach Instagram carousels.
 *
 * Unlike the trendingtech carousels which summarise existing comparisons,
 * DreamCoach has no editorial pipeline — content is generated fresh each
 * run by Gemini, with a different THEME each day of the week so the feed
 * stays varied without manual curation.
 *
 * 7 rotating themes (day-of-week, IL):
 *   Sun  → סמלים נפוצים בחלומות + פירושים
 *   Mon  → מה הפסיכולוגיה אומרת על חלומות
 *   Tue  → עובדות מדע השינה
 *   Wed  → ציטוטים מעוררי השראה על חלומות
 *   Thu  → מיתוסים תרבותיים סביב חלומות
 *   Fri  → חלומות חוזרים — מה הם אומרים
 *   Sat  → טיפים לזכירת ויומן חלומות
 *
 * Public API:
 *   buildDreamCoachContent(genAI, opts?) →
 *     {
 *       theme: { id, headline, subline, color },   // selected daily theme
 *       items: [
 *         { headline: string, body: string }       // up to 4 fact/tip slides
 *       ],
 *       cover: { headline: string, subline: string },
 *       cta:   { headline: string, subline: string },
 *     }
 *
 * Never throws — falls back to hand-written seed copy on Gemini failure
 * so the pipeline can still publish *something* if AI is unavailable.
 */

const { logger } = require('firebase-functions');

// ─── Themes ───────────────────────────────────────────────────────────────
// Each theme has bilingual metadata (he + en). The `promptTopic` is a single
// English description for Gemini — the model knows to write in the requested
// output language.
const THEMES = [
  // Sunday
  {
    id: 'dream-symbols',
    color: '#7C3AED', // violet 600
    he: { headline: 'סמלים בחלומות',         subline: 'מה באמת מסתתר מאחורי הדימויים שהמוח שלכם בוחר' },
    en: { headline: 'Dream Symbols',          subline: 'What the images your mind picks really mean' },
    promptTopic:
      'common symbols people see in dreams (e.g. water, falling, flying, teeth, snakes, houses) — give 4 SYMBOLS and what each tends to represent psychologically.',
  },
  // Monday
  {
    id: 'dream-psychology',
    color: '#6366F1', // indigo 500
    he: { headline: 'הפסיכולוגיה של החלום',  subline: 'מה מחקרים בנפש האדם אומרים על מה שאתם חולמים' },
    en: { headline: 'The Psychology of Dreams', subline: 'What research really says about why we dream' },
    promptTopic:
      'psychological perspectives on dreaming (Freud, Jung, modern cognitive science). Give 4 short evidence-based insights about why we dream what we dream — no woo, no horoscopes.',
  },
  // Tuesday
  {
    id: 'sleep-science',
    color: '#0EA5E9', // sky 500
    he: { headline: 'מדע השינה',              subline: 'מה קורה במוח בזמן שאתם חולמים' },
    en: { headline: 'The Science of Sleep',   subline: 'What your brain is actually doing while you dream' },
    promptTopic:
      'sleep science facts — REM, NREM stages, brainwave activity, memory consolidation, why we forget most dreams. 4 surprising scientifically-supported facts.',
  },
  // Wednesday
  {
    id: 'dream-quotes',
    color: '#F59E0B', // amber 500
    he: { headline: 'מילים על חלומות',        subline: 'ציטוטים מעוררי השראה ממחשבה לפעולה' },
    en: { headline: 'Words on Dreams',        subline: 'Inspiring quotes from thinkers who dreamed deeply' },
    promptTopic:
      '4 inspiring REAL quotes about dreams/dreaming/sleep from well-known thinkers (Jung, Freud, Einstein, scientists, writers). CITE the author. Skip generic motivational fluff.',
  },
  // Thursday
  {
    id: 'cultural-myths',
    color: '#EC4899', // pink 500
    he: { headline: 'חלומות בתרבויות',        subline: 'מה עמים שונים האמינו על העולם שמעבר לעיניים העצומות' },
    en: { headline: 'Dreams Across Cultures', subline: 'How different traditions read the night mind' },
    promptTopic:
      '4 distinct cultural beliefs about dreams from around the world (ancient Egypt, Greek oracles, Aboriginal dreamtime, Japanese yume, Native American dreamcatchers, Talmudic tradition, etc.). Fact-grounded and respectful.',
  },
  // Friday
  {
    id: 'recurring-dreams',
    color: '#8B5CF6', // violet 500
    he: { headline: 'חלומות חוזרים',          subline: 'מה החלום שחוזר אליכם שוב ושוב באמת מנסה לומר' },
    en: { headline: 'Recurring Dreams',       subline: 'What the dream that keeps coming back is trying to tell you' },
    promptTopic:
      '4 common recurring dream patterns (chase dreams, falling, teeth falling out, exams, being naked in public). For each: what triggers it and what it typically signals about the dreamer\'s emotional life.',
  },
  // Saturday
  {
    id: 'remember-dreams',
    color: '#10B981', // emerald 500
    he: { headline: 'איך לזכור חלומות',       subline: 'טיפים מעשיים להפוך את הזיכרון הלילי שלכם לחד יותר' },
    en: { headline: 'How to Remember Dreams', subline: 'Simple practical tips to make your dream recall sharper' },
    promptTopic:
      '4 evidence-based, practical tips for remembering dreams better (dream journal beside bed, no phone first thing, set intention, wake gradually, etc.). Actionable, not vague.',
  },
];

/** Resolve a theme into the language-specific surface used by the rest of
 *  the pipeline. */
function localizeTheme(rawTheme, language) {
  const t = rawTheme || THEMES[0];
  const loc = (language === 'en' ? t.en : t.he) || t.he;
  return {
    id: t.id,
    color: t.color,
    headline: loc.headline,
    subline: loc.subline,
    promptTopic: t.promptTopic,
  };
}

function pickTodaysTheme(now = new Date()) {
  // Use IL day-of-week. Sun=0, Mon=1, …, Sat=6.
  // Compute IL hour offset roughly — we don't have a tz lib here.
  const ilOffsetHours = 3; // covers most of the year; off by 1h in winter, doesn't shift weekday
  const ilMs = now.getTime() + ilOffsetHours * 3600_000;
  const dow = new Date(ilMs).getUTCDay();
  return THEMES[dow] || THEMES[0];
}

/** Hand-written safety nets — one per language — used when Gemini is unavailable. */
function fallbackPayload(theme, language) {
  if (language === 'en') {
    return {
      theme,
      cover: { headline: theme.headline, subline: theme.subline },
      items: [
        { headline: 'Your brain keeps working', body: 'Even while you sleep, your brain processes emotions, locks in memories, and reorganises them — that work shows up as dreams.' },
        { headline: 'You dream more than you think', body: 'The average adult has 4–6 dreams per night, but usually only remembers the last one — the one just before waking.' },
        { headline: 'Repeat dreams mean something', body: 'A dream that keeps coming back almost always points at an emotional theme you haven\'t fully processed yet in waking life.' },
        { headline: 'Write it fast', body: 'Within 10 minutes of waking, around 90% of a dream\'s detail is gone. Jot down even a single image — the rest tends to follow.' },
      ],
      cta: {
        headline: 'Want to decode your dream?',
        subline: 'DreamCoach analyses your dreams with AI and psychology, then hands you a clear personal interpretation.',
      },
    };
  }
  return {
    theme,
    cover: {
      headline: theme.headline,
      subline: theme.subline,
    },
    items: [
      { headline: 'דבר אחד שכדאי לדעת', body: 'גם המוח שלכם ממשיך לעבוד בזמן שאתם ישנים — מעבד רגשות, מקבע זיכרונות, ומסדר אותם מחדש.' },
      { headline: 'עוד עובדה', body: 'מבוגר ממוצע חולם 4-6 חלומות בלילה, אבל לרוב זוכר רק את האחרון שלפני ההתעוררות.' },
      { headline: 'תובנה', body: 'חלום שחוזר על עצמו לרוב מצביע על נושא רגשי שטרם הצלחנו לעבד במציאות.' },
      { headline: 'טיפ מעשי', body: 'כתבו את החלום מיד עם ההתעוררות — אחרי 10 דקות 90% מהפרטים נעלמים.' },
    ],
    cta: {
      headline: 'רוצים לפענח את החלום שלכם?',
      subline: 'הצוות של DreamCoach מנתח לכם — בעזרת AI ופסיכולוגיה — את מה שהמוח שלכם מנסה לומר.',
    },
  };
}

function buildPrompt(theme, language) {
  if (language === 'en') {
    return `You're a content writer for DreamCoach — an AI app that helps people understand their dreams. Voice: warm, intelligent, evidence-based (not cheap mysticism, no horoscopes, no new-age fluff).

Task: write content for 4 slides of an Instagram carousel post, in clean fluent English.

Post theme: ${theme.headline} — ${theme.subline}
Theme detail: ${theme.promptTopic}

Each slide needs:
- "headline" — a sharp 2–5 word headline that summarises the point
- "body" — body text: 1–2 sentences, 14–26 words, authentic and substantive, no clichés

Also produce:
- "coverHeadline" — main headline for the opening slide (2–4 energetic words)
- "coverSubline" — supporting line (6–10 words promising value)
- "ctaHeadline" — closing headline (3–5 words that pull readers to the app)
- "ctaSubline" — supporting line (10–16 words explaining what DreamCoach does: AI- and psychology-powered dream analysis)

Return JSON ONLY (no markdown, no explanation) in this exact shape:
{
  "coverHeadline": "...",
  "coverSubline": "...",
  "items": [
    { "headline": "...", "body": "..." },
    { "headline": "...", "body": "..." },
    { "headline": "...", "body": "..." },
    { "headline": "...", "body": "..." }
  ],
  "ctaHeadline": "...",
  "ctaSubline": "..."
}`;
  }
  return `אתה כותב תוכן ל-DreamCoach — אפליקציית AI שמסייעת לאנשים להבין את החלומות שלהם. הקול הוא חם, אינטליגנטי ומבוסס-מדע (לא מיסטיקה זולה ולא ניו אייג').

המשימה: ייצור תוכן ל-4 סלידים של פוסט קרוסלה באינסטגרם, בעברית רהוטה וכתיב מלא.

נושא הפוסט: ${theme.headline} — ${theme.subline}
פירוט הנושא: ${theme.promptTopic}

כל סלייד צריך:
- "headline" — כותרת חדה של 2-5 מילים שמסקרנת ומסכמת את הנקודה
- "body" — גוף הטקסט: 1-2 משפטים, 14-26 מילים, אותנטי ומבוסס, ללא קלישאות

נוסף לזה, ייצור:
- "coverHeadline" — כותרת ראשית לסלייד פתיחה (2-4 מילים אנרגטיות)
- "coverSubline" — שורת משנה (6-10 מילים מבטיחות ערך)
- "ctaHeadline" — כותרת לסיום (3-5 מילים שמושכות לאפליקציה)
- "ctaSubline" — שורת משנה (10-16 מילים שמסבירות מה DreamCoach עושה: ניתוח חלומות מבוסס AI ופסיכולוגיה)

החזר JSON בלבד (ללא markdown, ללא הסברים), במבנה:
{
  "coverHeadline": "...",
  "coverSubline": "...",
  "items": [
    { "headline": "...", "body": "..." },
    { "headline": "...", "body": "..." },
    { "headline": "...", "body": "..." },
    { "headline": "...", "body": "..." }
  ],
  "ctaHeadline": "...",
  "ctaSubline": "..."
}`;
}

/**
 * Use Gemini to generate today's content.
 *
 * @param {object} genAI  @google/genai client (REQUIRED)
 * @param {object} [opts]
 * @param {string} [opts.themeId]   override day-of-week pick
 * @param {'en'|'he'} [opts.language='he']
 * @returns {Promise<object>}
 */
async function buildDreamCoachContent(genAI, opts = {}) {
  const language = opts.language === 'en' ? 'en' : 'he';
  const rawTheme =
    (opts.themeId && THEMES.find((t) => t.id === opts.themeId)) ||
    pickTodaysTheme();
  const theme = localizeTheme(rawTheme, language);

  if (!genAI) {
    logger.warn('dreamCoachContent: Gemini unavailable — using fallback');
    return { language, ...fallbackPayload(theme, language) };
  }

  const prompt = buildPrompt(theme, language);

  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    const raw =
      (typeof result.text === 'function' ? result.text() : result.text) || '';
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) {
      logger.warn('dreamCoachContent: no JSON returned, using fallback');
      return { language, ...fallbackPayload(theme, language) };
    }
    const parsed = JSON.parse(m[0]);
    if (
      !parsed ||
      !Array.isArray(parsed.items) ||
      parsed.items.length < 3
    ) {
      logger.warn('dreamCoachContent: bad shape, using fallback');
      return { language, ...fallbackPayload(theme, language) };
    }
    const defaultCtaHeadline =
      language === 'en' ? 'Want to decode your dream?' : 'רוצים לפענח את החלום שלכם?';
    const defaultCtaSubline =
      language === 'en'
        ? 'DreamCoach analyses your dreams with AI and psychology and hands back personal insights.'
        : 'DreamCoach מנתח חלומות בעזרת AI ופסיכולוגיה ומחזיר לכם תובנות מותאמות אישית.';
    return {
      language,
      theme,
      cover: {
        headline: String(parsed.coverHeadline || theme.headline).trim(),
        subline: String(parsed.coverSubline || theme.subline).trim(),
      },
      items: parsed.items.slice(0, 4).map((it) => ({
        headline: String(it.headline || '').trim().slice(0, 60),
        body: String(it.body || '').trim().slice(0, 280),
      })),
      cta: {
        headline: String(parsed.ctaHeadline || defaultCtaHeadline).trim(),
        subline: String(parsed.ctaSubline || defaultCtaSubline).trim(),
      },
    };
  } catch (err) {
    logger.warn('dreamCoachContent generation failed:', err.message);
    return { language, ...fallbackPayload(theme, language) };
  }
}

module.exports = {
  buildDreamCoachContent,
  THEMES,
  pickTodaysTheme,
};
