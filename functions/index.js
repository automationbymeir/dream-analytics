const admin = require('firebase-admin');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const axios = require('axios');
const nodemailer = require('nodemailer');
const mammoth = require('mammoth');

admin.initializeApp();
const db = admin.firestore();

// ─── Configuration ────────────────────────────────────────────────────────────
// Keys loaded from functions/.env (Firebase v2 picks this up automatically).

const VERTEX_AI_KEY   = () => process.env.GEMINI_API_KEY;
const VERTEX_MODEL    = 'gemini-2.5-flash-lite';
const VERTEX_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${VERTEX_MODEL}:generateContent`;
const PAYPAL_CLIENT   = () => process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET   = () => process.env.PAYPAL_SECRET;
const PAYPAL_BASE_URL = 'https://api-m.paypal.com';

const FREE_TIER_LIMIT = 3;
const GCP_PROJECT    = 'dreamanalysis-39322';
const IMAGEN_MODEL   = 'imagen-3.0-fast-generate-001';

// ─── Jungian Prompts ──────────────────────────────────────────────────────────
const JUNGIAN_PROMPT = `You are a professional Jungian dream analyst and personal development coach.
Analyze the user's dream, identifying symbols and archetypes from a Jungian perspective.
Provide insights about what the dream might reveal about the dreamer's unconscious mind,
current life situation, or psychological state. Be warm, insightful, and helpful.`;

const ALT_PROMPT = `Also provide alternative interpretations using Freudian and Gestalt frameworks.
Then generate three deep, open-ended reflection questions based on the analysis.

Structure your full response with clearly labeled sections:
**Jungian Analysis**
**Alternative Interpretations (Freudian & Gestalt)**
**Reflection Questions**`;

// ─── Email ────────────────────────────────────────────────────────────────────

function createMailTransport() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user, pass }
  });
}

async function sendEmail(to, subject, html) {
  const transport = createMailTransport();
  if (!transport) {
    console.log('[Email] SMTP not configured. Skipping email to:', to, '|', subject);
    return;
  }
  try {
    await transport.sendMail({
      from: `"DreamCoach 🌙" <${process.env.SMTP_USER}>`,
      replyTo: 'service@dream-analytics.com',
      to, subject, html
    });
    console.log('[Email] Sent to:', to);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

const EMAIL_BRAND = `
  <div style="font-family:'Segoe UI',Arial,sans-serif;background:#0F0D1F;color:#e2e8f0;max-width:600px;margin:0 auto;border-radius:16px;overflow:hidden;border:1px solid rgba(167,139,250,0.15);">
    <div style="background:linear-gradient(135deg,#1a1535 0%,#2d1b69 100%);padding:32px 32px 24px;text-align:center;">
      <div style="font-size:32px;margin-bottom:8px;">🌙</div>
      <div style="font-family:Georgia,serif;font-size:24px;font-style:italic;color:#fbbf24;letter-spacing:0.5px;">DreamCoach</div>
      <div style="font-size:11px;color:rgba(167,139,250,0.5);letter-spacing:2px;text-transform:uppercase;margin-top:4px;">by Automation By Meir</div>
    </div>
    <div style="padding:32px;">
`;
const EMAIL_FOOTER = `
    </div>
    <div style="padding:20px 32px;border-top:1px solid rgba(167,139,250,0.1);text-align:center;font-size:11px;color:rgba(167,139,250,0.4);">
      DreamCoach Analytics &nbsp;·&nbsp; A product of <a href="https://www.automationbymeir.com" style="color:#f9a825;text-decoration:none;">Automation By Meir</a><br/>
      Questions? <a href="mailto:service@dream-analytics.com" style="color:#f9a825;text-decoration:none;">service@dream-analytics.com</a> &nbsp;·&nbsp; <a href="https://dreamanalysis-39322.web.app/privacy.html" style="color:rgba(167,139,250,0.5);text-decoration:none;">Privacy</a>
    </div>
  </div>
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callVertexAI(prompt) {
  const key = VERTEX_AI_KEY();
  if (!key) throw new HttpsError('failed-precondition', 'Vertex AI not configured.');
  const res = await axios.post(
    `${VERTEX_ENDPOINT}?key=${key}`,
    { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return res.data.candidates[0].content.parts[0].text;
}

async function getGCPAccessToken() {
  // Uses the GCP metadata server — available automatically in Cloud Functions
  const res = await axios.get(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  return res.data.access_token;
}

async function generateDreamImage(description, uid, dreamId) {
  const prompt =
    `A surreal, ethereal dreamscape painting. Scene and mood: ${description.substring(0, 350)}. ` +
    'Style: soft glowing colors, mystical atmosphere, impressionist dream art, cinematic lighting. No text, no words, no letters.';

  const token = await getGCPAccessToken();
  const res = await axios.post(
    `https://us-central1-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT}/locations/us-central1/publishers/google/models/${IMAGEN_MODEL}:predict`,
    { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '4:3' } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  const base64 = res.data.predictions[0].bytesBase64Encoded;
  const bucket = admin.storage().bucket();
  const fileName = `dream-images/${uid}/${dreamId}.jpg`;
  const file = bucket.file(fileName);
  await file.save(Buffer.from(base64, 'base64'), {
    metadata: { contentType: 'image/jpeg' }
  });
  await file.makePublic();
  const imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
  await db.doc(`dreams/${dreamId}`).update({ imageUrl });
  return imageUrl;
}

async function getPayPalToken() {
  const res = await axios.post(
    `${PAYPAL_BASE_URL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: PAYPAL_CLIENT(), password: PAYPAL_SECRET() },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  return res.data.access_token;
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function ensureUserDoc(uid, token) {
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      email: token.email || '',
      displayName: token.name || token.email || '',
      subscriptionStatus: 'free',
      subscriptionId: null,
      subscriptionExpiry: null,
      monthlyUsage: 0,
      monthlyUsageReset: currentMonthKey(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  return ref;
}

// ─── analyzeDream ─────────────────────────────────────────────────────────────

const PERSONAL_VIDEO_SECRETS = [
  "DREAM_REMOTION_SERVE_URL",
  "DREAM_REMOTION_FUNCTION_NAME",
  "REMOTION_AWS_ACCESS_KEY_ID",
  "REMOTION_AWS_SECRET_ACCESS_KEY",
  "PEXELS_API_KEY",
  "ELEVENLABS_API_KEY",
];

exports.analyzeDream = onCall({ cors: true, memory: '512MiB', secrets: PERSONAL_VIDEO_SECRETS }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login required.');
  }

  const uid = request.auth.uid;
  const { description, dreamDate, name } = request.data;

  if (!description || description.trim().length < 20) {
    throw new HttpsError('invalid-argument', 'Please provide a fuller dream description (at least 20 characters).');
  }

  const userRef = await ensureUserDoc(uid, request.auth.token);
  const userSnap = await userRef.get();
  const user = userSnap.data();

  // Subscription & usage check
  let isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
  if (isPro && user.subscriptionExpiry && user.subscriptionExpiry.toDate() < new Date()) {
    await userRef.update({ subscriptionStatus: 'free' });
    isPro = false;
  }

  const monthKey = currentMonthKey();
  let usage = user.monthlyUsage || 0;
  if ((user.monthlyUsageReset || '') !== monthKey) {
    usage = 0;
    await userRef.update({ monthlyUsage: 0, monthlyUsageReset: monthKey });
  }

  if (!isPro && usage >= FREE_TIER_LIMIT) {
    throw new HttpsError(
      'resource-exhausted',
      `Free tier limit of ${FREE_TIER_LIMIT} analyses/month reached. Upgrade to Pro for unlimited access.`
    );
  }

  // Vertex AI call
  const isHebrew = /[\u0590-\u05FF]/.test(description);
  let analysis;
  try {
    const langInstruction = isHebrew ? "\n\nIMPORTANT: You must output your ENTIRE analysis in fluent, native Hebrew. Ensure the layout and formatting is suitable for Hebrew readers (RTL)." : "";
    const prompt = `${JUNGIAN_PROMPT}\n\n${ALT_PROMPT}${langInstruction}\n\nDream to analyze:\n"${description.trim()}"`;
    analysis = await callVertexAI(prompt);
  } catch (err) {
    console.error('Vertex AI error:', err.response?.data || err.message);
    throw new HttpsError('internal', 'AI analysis failed. Please try again.');
  }

  // Save dream
  const dreamRef = await db.collection('dreams').add({
    userId: uid,
    name: name || request.auth.token.name || '',
    email: request.auth.token.email || '',
    dreamDate: dreamDate || new Date().toISOString().split('T')[0],
    description: description.trim(),
    analysis,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  await userRef.update({ monthlyUsage: admin.firestore.FieldValue.increment(1) });

  // Generate dream image via Imagen (non-blocking — result saved to Firestore async)
  generateDreamImage(description.trim(), uid, dreamRef.id).catch(err => {
    console.error('Imagen generation error:', err.response?.data || err.message);
  });

  // Generate personal dream video for Pro users (non-blocking — result saved to Firestore async)
  if (isPro) {
    const { generatePersonalDreamVideo } = require('./dreamVideoPipeline');
    generatePersonalDreamVideo({
      dreamId: dreamRef.id,
      userId: uid,
      description: description.trim(),
      analysis,
      userName: name || request.auth.token.name || '',
      language: isHebrew ? 'he' : 'en',
      dreamDate: dreamDate || new Date().toISOString().split('T')[0],
    }).catch(err => console.error('Personal video generation error:', err.message));
  }

  // Send dream confirmation email (non-blocking)
  const userEmail = request.auth.token.email;
  if (userEmail) {
    const shortDesc = description.trim().substring(0, 120) + (description.length > 120 ? '…' : '');
    const shortAnalysis = analysis.substring(0, 300) + (analysis.length > 300 ? '…' : '');
    sendEmail(userEmail, '✨ Your Dream Has Been Analyzed – DreamCoach',
      EMAIL_BRAND +
      `<h2 style="font-family:Georgia,serif;font-style:italic;color:#fbbf24;font-size:22px;margin:0 0 16px;">Your Dream Analysis is Ready</h2>
       <p style="color:rgba(196,181,253,0.7);line-height:1.6;margin:0 0 16px;">Here's a glimpse of tonight's insights:</p>
       <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:12px;padding:16px;margin-bottom:16px;">
         <div style="font-size:11px;color:rgba(167,139,250,0.5);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Your Dream</div>
         <p style="color:#e2e8f0;font-style:italic;line-height:1.6;margin:0;">"${shortDesc}"</p>
       </div>
       <div style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);border-radius:12px;padding:16px;margin-bottom:24px;">
         <div style="font-size:11px;color:rgba(167,139,250,0.5);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Analysis Preview</div>
         <p style="color:#e2e8f0;line-height:1.6;margin:0;">${shortAnalysis}</p>
       </div>
       <a href="https://dreamanalysis-39322.web.app/dashboard.html" style="display:inline-block;background:#f9a825;color:#0F0D1F;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.5px;">View Full Analysis →</a>` +
      EMAIL_FOOTER
    ).catch(() => {});
  }

  const remaining = isPro ? null : Math.max(0, FREE_TIER_LIMIT - usage - 1);
  return { success: true, dreamId: dreamRef.id, analysis, remainingFree: remaining };
});

// ─── analyzeDreamTrends (Pro only) ───────────────────────────────────────────

exports.analyzeDreamTrends = onCall({ cors: true, memory: '512MiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { prompt: userPrompt, dateFrom, dateTo } = request.data;

  if (!userPrompt || userPrompt.trim().length < 5) {
    throw new HttpsError('invalid-argument', 'Please provide an analysis prompt.');
  }

  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'User profile not found.');
  const user = userSnap.data();
  const isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
  if (!isPro || (user.subscriptionExpiry && user.subscriptionExpiry.toDate() < new Date())) {
    throw new HttpsError('permission-denied', 'Trend analysis requires a Pro subscription.');
  }

  let query = db.collection('dreams').where('userId', '==', uid);
  if (dateFrom) query = query.where('dreamDate', '>=', dateFrom);
  if (dateTo)   query = query.where('dreamDate', '<=', dateTo);
  query = query.orderBy('dreamDate', 'desc').limit(50);

  const snap = await query.get();
  if (snap.empty) throw new HttpsError('not-found', 'No dreams found in the specified date range.');

  const dreams = snap.docs.map((d, i) => {
    const dd = d.data();
    return `Dream ${i + 1} (${dd.dreamDate || 'unknown date'}):\n${dd.description}`;
  });

  const isHebrew = /[\u0590-\u05FF]/.test(userPrompt) || /[\u0590-\u05FF]/.test(dreams.join(' '));
  const langInstruction = isHebrew ? "\n\nIMPORTANT: You must write your ENTIRE analysis response exclusively in fluent, native Hebrew (RTL)." : "";

  const systemPrompt = `You are an expert dream analyst specializing in identifying patterns across multiple dream journal entries.
Analyze the following dreams based on the user's request. Identify key recurring elements, symbols, archetypes, and psychological themes.
Structure your response clearly with sections for Key Themes, Detailed Analysis, and Insights for Personal Growth.${langInstruction}

User's analysis request: "${userPrompt.trim()}"

Dreams to analyze:
${dreams.join('\n\n')}`;

  let analysis;
  try {
    analysis = await callVertexAI(systemPrompt);
  } catch (err) {
    console.error('Vertex AI trend error:', err.response?.data || err.message);
    throw new HttpsError('internal', 'Trend analysis failed. Please try again.');
  }

  return {
    success: true,
    dreamCount: snap.size,
    dateRange: `${dateFrom || 'all time'} to ${dateTo || 'today'}`,
    analysis
  };
});

// ─── verifyPayPalSubscription ─────────────────────────────────────────────────

exports.verifyPayPalSubscription = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { subscriptionId, planType } = request.data;

  if (!subscriptionId || !planType) {
    throw new HttpsError('invalid-argument', 'Missing subscriptionId or planType.');
  }

  try {
    const token = await getPayPalToken();
    const res = await axios.get(
      `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const sub = res.data;
    if (sub.status !== 'ACTIVE') {
      throw new HttpsError('failed-precondition', `Subscription status is ${sub.status}, not ACTIVE.`);
    }

    const expiry = new Date();
    if (planType === 'yearly') expiry.setFullYear(expiry.getFullYear() + 1);
    else { expiry.setMonth(expiry.getMonth() + 1); expiry.setDate(expiry.getDate() + 2); }

    const status = planType === 'yearly' ? 'pro_yearly' : 'pro_monthly';
    
    // Check previous status to send welcome email only on first upgrade
    const userSnap = await db.doc(`users/${uid}`).get();
    let wasFree = false;
    if (userSnap.exists) {
      const u = userSnap.data();
      wasFree = u.subscriptionStatus === 'free' || !u.subscriptionStatus;
    }

    await db.doc(`users/${uid}`).update({
      subscriptionStatus: status,
      subscriptionId,
      subscriptionExpiry: admin.firestore.Timestamp.fromDate(expiry)
    });

    if (wasFree && request.auth.token.email) {
      const price = planType === 'yearly' ? '$192.00 / year' : '$20.00 / month';
      const emailHtml = EMAIL_BRAND + 
      `<div dir="rtl" style="text-align:right; font-family:Arial,sans-serif;">
         <h2 style="font-family:Georgia,serif;font-style:italic;color:#fbbf24;font-size:24px;margin:0 0 16px;">ברוכים הבאים ל-DreamCoach Pro! ✨</h2>
         <p style="color:rgba(196,181,253,0.9);line-height:1.6;margin:0 0 16px;">תודה שבחרת לשדרג את המנוי. השכבות העמוקות ביותר של תת המודע שלך פתוחות כעת לחלוטין למחקר ולגילוי.</p>
         
         <h3 style="color:#fbbf24;margin-top:24px;margin-bottom:8px;">קבלה וחשבונית</h3>
         <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:12px;padding:16px;margin-bottom:24px;">
           <p style="color:#e2e8f0;margin:4px 0;"><strong>מסלול:</strong> DreamCoach Pro (${planType})</p>
           <p style="color:#e2e8f0;margin:4px 0;"><strong>מחיר:</strong> ${price}</p>
           <p style="color:#e2e8f0;margin:4px 0;"><strong>מזהה מנוי במערכת (PayPal ID):</strong> ${subscriptionId}</p>
           <p style="color:#e2e8f0;margin:4px 0;"><strong>תאריך חיוב:</strong> ${new Date().toLocaleDateString()}</p>
         </div>
         
         <h3 style="color:#fbbf24;margin-bottom:8px;">מה נפתח בפניך כעת? 🔓</h3>
         <ul style="color:rgba(196,181,253,0.9);line-height:1.6;margin-bottom:24px;padding-right:20px;">
           <li style="margin-bottom:6px;"><strong>ניתוח אינסופי:</strong> ניתן לנתח כמות בלתי מוגבלת של חלומות, בכל זמן.</li>
           <li style="margin-bottom:6px;"><strong>צ׳אט ללא הגבלות:</strong> שאל את המאמנת שלנו שאלות אינסופיות כדי לחקור לעומק כל סמל שמופיע.</li>
           <li style="margin-bottom:6px;"><strong>ייצוא מסמכים (.doc):</strong> בקליק אחד, ניתן להוריד מסמכי וורד אלגנטיים של הנרטיב העמוק ושאלות ההמשך ששאלת.</li>
           <li style="margin-bottom:6px;"><strong>שליחת סיכום למייל:</strong> העבר לעצמך סיכומים ישירות למייל כדי להבטיח שהתובנות לא יאבדו לעולם.</li>
         </ul>
         <p style="color:rgba(196,181,253,0.9);line-height:1.6;margin:0;">אנחנו מאחלים לך מסע מופלא אל תוך הנפש.<br>צוות DreamCoach 🌙</p>
       </div>` + EMAIL_FOOTER;

      sendEmail(request.auth.token.email, '💎 ברוכים הבאים ל-DreamCoach Pro + חשבונית קבלה', emailHtml).catch(e => console.error('Welcome email error:', e));
    }

    return { success: true, status, expiry: expiry.toISOString() };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('PayPal verify error:', err.response?.data || err.message);
    throw new HttpsError('internal', 'Failed to verify subscription with PayPal.');
  }
});

// ─── cancelSubscription ───────────────────────────────────────────────────────

exports.cancelSubscription = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'User not found.');

  const { subscriptionId } = userSnap.data();
  if (!subscriptionId) throw new HttpsError('not-found', 'No active subscription found.');

  try {
    const token = await getPayPalToken();
    await axios.post(
      `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}/cancel`,
      { reason: 'User requested cancellation.' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    await db.doc(`users/${uid}`).update({
      subscriptionStatus: 'free',
      subscriptionId: null,
      subscriptionExpiry: null
    });
    return { success: true };
  } catch (err) {
    console.error('Cancel error:', err.response?.data || err.message);
    throw new HttpsError('internal', 'Failed to cancel subscription.');
  }
});

// ─── setupPayPalPlans (HTTP – call once to create plans) ──────────────────────

exports.setupPayPalPlans = onRequest({ cors: true }, async (req, res) => {
  if (req.query.secret !== 'dreamcoach-setup-2024') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const token = await getPayPalToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const productRes = await axios.post(`${PAYPAL_BASE_URL}/v1/catalogs/products`, {
      name: 'DreamCoach Pro',
      description: 'Unlimited dream analyses, trend analysis, and insights.',
      type: 'SERVICE',
      category: 'SOFTWARE'
    }, { headers });
    const productId = productRes.data.id;

    const monthlyRes = await axios.post(`${PAYPAL_BASE_URL}/v1/billing/plans`, {
      product_id: productId,
      name: 'DreamCoach Pro – Monthly',
      description: 'Unlimited dream analyses billed monthly.',
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: '20.00', currency_code: 'USD' } }
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: '0', currency_code: 'USD' },
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3
      }
    }, { headers });

    const yearlyRes = await axios.post(`${PAYPAL_BASE_URL}/v1/billing/plans`, {
      product_id: productId,
      name: 'DreamCoach Pro – Yearly',
      description: 'Unlimited dream analyses billed annually (save 20%).',
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'YEAR', interval_count: 1 },
        tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
        pricing_scheme: { fixed_price: { value: '192.00', currency_code: 'USD' } }
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: '0', currency_code: 'USD' },
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3
      }
    }, { headers });

    await db.doc('config/paypal').set({
      productId,
      monthlyPlanId: monthlyRes.data.id,
      yearlyPlanId: yearlyRes.data.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, productId, monthlyPlanId: monthlyRes.data.id, yearlyPlanId: yearlyRes.data.id });
  } catch (err) {
    console.error('Setup error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── paypalWebhook ────────────────────────────────────────────────────────────

exports.paypalWebhook = onRequest({ cors: true }, async (req, res) => {
  const event = req.body;
  const eventType = event.event_type;
  const subscriptionId = event.resource?.id || event.resource?.billing_agreement_id;

  console.log('PayPal webhook:', eventType, subscriptionId);

  try {
    if (!subscriptionId) return res.status(200).send('OK');

    const usersSnap = await db.collection('users')
      .where('subscriptionId', '==', subscriptionId).limit(1).get();
    if (usersSnap.empty) return res.status(200).send('OK – user not found');

    const userRef = usersSnap.docs[0].ref;

    switch (eventType) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await userRef.update({ subscriptionStatus: 'pro_monthly' });
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        await userRef.update({ subscriptionStatus: 'free', subscriptionId: null, subscriptionExpiry: null });
        break;
      case 'PAYMENT.SALE.COMPLETED': {
        const userSnap = await userRef.get();
        const user = userSnap.data();
        const base = user.subscriptionExpiry ? user.subscriptionExpiry.toDate() : new Date();
        const newExpiry = new Date(Math.max(base, new Date()));
        if (user.subscriptionStatus === 'pro_yearly') newExpiry.setFullYear(newExpiry.getFullYear() + 1);
        else newExpiry.setMonth(newExpiry.getMonth() + 1);
        await userRef.update({ subscriptionExpiry: admin.firestore.Timestamp.fromDate(newExpiry) });
        break;
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK');
  }
});

// ─── redeemCoupon ─────────────────────────────────────────────────────────────

const COUPON_CODES = {
  'DREAMFREE':  { days: 30,  label: '30-day Pro access' },
  'DREAMTEST':  { days: 30,  label: '30-day Pro access' },
  'DREAMVIP':   { days: 365, label: '1-year Pro access' },
};

exports.redeemCoupon = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const code = (request.data.code || '').toUpperCase().trim();

  const coupon = COUPON_CODES[code];
  if (!coupon) throw new HttpsError('not-found', 'Invalid or expired coupon code.');

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (userSnap.exists) {
    const userData = userSnap.data();
    if (['pro_monthly', 'pro_yearly'].includes(userData.subscriptionStatus)) {
      throw new HttpsError('already-exists', 'You already have an active Pro subscription.');
    }
  }

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + coupon.days);

  await userRef.set({
    subscriptionStatus: 'pro_monthly',
    subscriptionId: `coupon:${code}`,
    subscriptionExpiry: admin.firestore.Timestamp.fromDate(expiry)
  }, { merge: true });

  return { success: true, message: `${coupon.label} activated! Enjoy DreamCoach Pro.` };
});

// ─── sendWelcomeEmail ─────────────────────────────────────────────────────────

exports.sendWelcomeEmail = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  const email = request.auth.token.email;
  const name  = request.auth.token.name || 'Dream Explorer';
  if (!email) return { success: false };

  await sendEmail(email, '🌙 Welcome to DreamCoach — Your Journey Begins',
    EMAIL_BRAND +
    `<h2 style="font-family:Georgia,serif;font-style:italic;color:#fbbf24;font-size:24px;margin:0 0 16px;">Welcome, ${name}.</h2>
     <p style="color:rgba(196,181,253,0.7);line-height:1.7;margin:0 0 16px;">You've just taken the first step into a deeper understanding of your subconscious mind. DreamCoach uses advanced Jungian, Freudian, and Gestalt AI analysis to decode the hidden meanings in your dreams.</p>
     <h3 style="font-family:Georgia,serif;color:#e2e8f0;font-size:16px;margin:24px 0 12px;">Getting Started:</h3>
     <ol style="color:rgba(196,181,253,0.7);line-height:1.8;padding-left:20px;margin:0 0 24px;">
       <li>Record a dream on the <strong style="color:#e2e8f0;">home page</strong> — aim for as much detail as you remember.</li>
       <li>Receive your full Jungian analysis in seconds.</li>
       <li>Explore your <strong style="color:#e2e8f0;">Dream Journal</strong> on the Dashboard.</li>
       <li>Unlock <strong style="color:#fbbf24;">Pro features</strong> for unlimited analyses and pattern insights.</li>
     </ol>
     <a href="https://dreamanalysis-39322.web.app" style="display:inline-block;background:#f9a825;color:#0F0D1F;padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.5px;margin-bottom:24px;">Start Exploring Dreams →</a>
     <p style="color:rgba(167,139,250,0.5);font-size:13px;line-height:1.6;margin:0;">Need help? Chat with our AI support guide at <a href="https://dreamanalysis-39322.web.app/support.html" style="color:#f9a825;">the support page</a> or email us at <a href="mailto:service@dream-analytics.com" style="color:#f9a825;">service@dream-analytics.com</a>.</p>` +
    EMAIL_FOOTER
  );
  return { success: true };
});

// ─── supportChat ──────────────────────────────────────────────────────────────

exports.supportChat = onCall({ cors: true, memory: '512MiB' }, async (request) => {
  const { message, history } = request.data;
  if (!message || message.trim().length < 2) {
    throw new HttpsError('invalid-argument', 'Please provide a message.');
  }

  const systemContext = `You are a friendly and knowledgeable customer support agent for DreamCoach Analytics, a web app built by Automation By Meir.

DreamCoach key facts:
- Records and analyzes dreams using AI (Jungian, Freudian, Gestalt frameworks)
- Free plan: 3 analyses/month. Pro Monthly: $20/mo. Pro Yearly: $192/yr (save 20%).
- Features: dream journal, AI analysis, dashboard, pattern trend analysis (Pro only), export (Pro only)
- Coupon codes: users can enter codes on the Pricing page to unlock Pro access
- Google Calendar reminders: available on Dashboard
- Settings: profile, subscription management, account deletion
- Cancel subscription anytime from Settings → Subscription
- 30-Day Moonphase Guarantee: full refund within 30 days
- Support email: service@dream-analytics.com
- Website: https://www.automationbymeir.com
- PayPal is used for payments

Be concise, warm, and helpful. If a user asks about a technical error, guide them step by step. For billing disputes, direct them to service@dream-analytics.com. Do not make up information not listed above.`;

  const contents = [];
  if (history && Array.isArray(history)) {
    history.forEach(h => {
      contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: h.text }] });
    });
  }
  contents.push({ role: 'user', parts: [{ text: `${systemContext}\n\n---\nUser: ${message.trim()}` }] });

  let reply;
  try {
    reply = await callVertexAI(contents[contents.length - 1].parts[0].text);
  } catch (err) {
    console.error('Support chat error:', err.message);
    throw new HttpsError('internal', 'Support AI unavailable. Please email service@dream-analytics.com.');
  }

  return { reply };
});

// ─── monthlySummaryEmail (runs 1st of every month at 9:00 AM UTC) ─────────────

exports.monthlySummaryEmail = onSchedule({ schedule: '0 9 1 * *', timeZone: 'UTC' }, async () => {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthKey  = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
  const monthName = lastMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const usersSnap = await db.collection('users').get();
  let sent = 0;

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();
    const email = user.email;
    if (!email) continue;

    try {
      // Count dreams this past month
      const dreamsSnap = await db.collection('dreams')
        .where('userId', '==', userDoc.id)
        .where('dreamDate', '>=', `${lastMonth.getFullYear()}-${String(lastMonth.getMonth()+1).padStart(2,'0')}-01`)
        .where('dreamDate', '<=', `${lastMonth.getFullYear()}-${String(lastMonth.getMonth()+1).padStart(2,'0')}-31`)
        .get();
      const dreamCount = dreamsSnap.size;
      if (dreamCount === 0) continue; // only email active users

      const isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
      const name  = user.displayName || 'Dream Explorer';

      // Generate monthly recap video for Pro users (non-blocking)
      if (isPro) {
        const { generateMonthlyRecapVideoForUser } = require('./dreamVideoPipeline');
        const isHebrew = /[\u0590-\u05FF]/.test(name) || /[\u0590-\u05FF]/.test(email);
        const dreams = dreamsSnap.docs.map(dd => dd.data());
        generateMonthlyRecapVideoForUser({
          userId: userDoc.id,
          userName: name,
          dreams,
          monthLabel: monthName,
          language: isHebrew ? 'he' : 'en',
        }).catch(err => console.error('Monthly recap video error for', email, err.message));
      }

      const proSection = isPro ? '' :
        `<div style="background:linear-gradient(135deg,rgba(124,58,237,0.2),rgba(249,168,37,0.1));border:1px solid rgba(249,168,37,0.3);border-radius:12px;padding:20px;margin-top:24px;text-align:center;">
           <div style="font-family:Georgia,serif;font-size:18px;font-style:italic;color:#fbbf24;margin-bottom:8px;">✨ Unlock Your Full Potential</div>
           <p style="color:rgba(196,181,253,0.7);font-size:13px;line-height:1.6;margin:0 0 16px;">You've been on the free plan. Upgrade to Pro for unlimited analyses, pattern trend insights, and export capabilities.</p>
           <a href="https://dreamanalysis-39322.web.app/pricing.html" style="display:inline-block;background:#f9a825;color:#0F0D1F;padding:10px 24px;border-radius:50px;text-decoration:none;font-weight:700;font-size:13px;">View Pro Plans →</a>
         </div>`;

      await sendEmail(email, `🌙 Your DreamCoach Summary for ${monthName}`,
        EMAIL_BRAND +
        `<h2 style="font-family:Georgia,serif;font-style:italic;color:#fbbf24;font-size:22px;margin:0 0 8px;">Monthly Dream Summary</h2>
         <p style="color:rgba(196,181,253,0.5);font-size:13px;margin:0 0 24px;">${monthName}</p>
         <p style="color:rgba(196,181,253,0.7);line-height:1.7;margin:0 0 24px;">Hi ${name}, here's a look at your dream journey last month:</p>
         <div style="display:flex;gap:16px;margin-bottom:24px;">
           <div style="flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:12px;padding:16px;text-align:center;">
             <div style="font-size:36px;font-family:Georgia,serif;color:#fbbf24;">${dreamCount}</div>
             <div style="font-size:11px;color:rgba(167,139,250,0.5);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Dreams Recorded</div>
           </div>
           <div style="flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:12px;padding:16px;text-align:center;">
             <div style="font-size:18px;font-family:Georgia,serif;color:${isPro?'#fbbf24':'rgba(167,139,250,0.7)'};">${isPro ? '⭐ Pro' : 'Free'}</div>
             <div style="font-size:11px;color:rgba(167,139,250,0.5);letter-spacing:1px;text-transform:uppercase;margin-top:4px;">Current Plan</div>
           </div>
         </div>
         <a href="https://dreamanalysis-39322.web.app/dashboard.html" style="display:inline-block;background:rgba(124,58,237,0.4);border:1px solid rgba(124,58,237,0.4);color:#e2e8f0;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:700;font-size:14px;">View Your Journal →</a>
         ${proSection}` +
        EMAIL_FOOTER
      );
      sent++;
    } catch (err) {
      console.error('Monthly email error for', email, err.message);
    }
  }
  console.log(`[Monthly] Sent ${sent} summary emails for ${monthName}`);
});

// ─── Pro Feature: Extract Text from Docx ──────────────────────────────────────

exports.extractTextFromDoc = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');
  
  const uid = request.auth.uid;
  const userSnap = await db.doc(`users/${uid}`).get();
  const user = userSnap.data() || {};
  
  const isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
  if (!isPro || (user.subscriptionExpiry && user.subscriptionExpiry.toDate() < new Date())) {
    throw new HttpsError('permission-denied', 'Uploading a doc file is a Pro feature.');
  }

  const { fileBase64 } = request.data;
  if (!fileBase64) throw new HttpsError('invalid-argument', 'No file provided.');

  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    const result = await mammoth.extractRawText({ buffer });
    return { success: true, text: result.value };
  } catch (err) {
    console.error('Doc extraction error:', err.message);
    throw new HttpsError('internal', 'Could not extract text from document. Ensure it is a valid .docx file.');
  }
});

// ─── Pro Feature: Email Dream Summary ─────────────────────────────────────────

exports.emailDreamSummary = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const userSnap = await db.doc(`users/${uid}`).get();
  const user = userSnap.data() || {};
  
  const isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
  if (!isPro || (user.subscriptionExpiry && user.subscriptionExpiry.toDate() < new Date())) {
    throw new HttpsError('permission-denied', 'Emailing a dream summary is a Pro feature.');
  }

  const { description, analysis, date } = request.data;
  const email = request.auth.token.email;
  
  if (!email || !description || !analysis) {
    throw new HttpsError('invalid-argument', 'Missing details to send email.');
  }

  try {
    const name = user.displayName || 'Dreamer';
    await sendEmail(email, `🌙 Dream Summary (${date})`,
      EMAIL_BRAND +
      `<h2 style="font-family:Georgia,serif;font-style:italic;color:#fbbf24;font-size:22px;margin:0 0 16px;">Your Dream Summary (${date})</h2>
       <p style="color:rgba(196,181,253,0.7);line-height:1.6;margin:0 0 16px;">Hi ${name}, as requested, here is a copy of your dream and its analysis.</p>
       <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:12px;padding:16px;margin-bottom:16px;">
         <div style="font-size:11px;color:rgba(167,139,250,0.5);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Your Dream</div>
         <p style="color:#e2e8f0;font-style:italic;line-height:1.6;margin:0;white-space:pre-wrap;">${description}</p>
       </div>
       <div style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.2);border-radius:12px;padding:16px;margin-bottom:24px;">
         <div style="font-size:11px;color:rgba(167,139,250,0.5);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">AI Analysis</div>
         <p style="color:#e2e8f0;line-height:1.6;margin:0;white-space:pre-wrap;">${analysis}</p>
       </div>` +
      EMAIL_FOOTER
    );
    return { success: true };
  } catch (err) {
    console.error('Email summary error:', err.message);
    throw new HttpsError('internal', 'Could not send the email.');
  }
});

// ─── askFollowUpQuestion ───────────────────────────────────────────────────────

exports.askFollowUpQuestion = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required.');

  const uid = request.auth.uid;
  const { dreamId, question } = request.data;
  
  if (!dreamId || !question || question.trim().length < 2) {
    throw new HttpsError('invalid-argument', 'Missing dream ID or question.');
  }

  const dreamRef = db.doc(`dreams/${dreamId}`);
  const dreamSnap = await dreamRef.get();
  
  if (!dreamSnap.exists) {
    throw new HttpsError('not-found', 'Dream not found.');
  }
  
  const dreamData = dreamSnap.data();
  if (dreamData.userId !== uid) {
    throw new HttpsError('permission-denied', 'Not authorized to access this dream.');
  }

  const userRef = await ensureUserDoc(uid, request.auth.token);
  const userSnap = await userRef.get();
  const user = userSnap.data();

  let isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
  if (isPro && user.subscriptionExpiry && user.subscriptionExpiry.toDate() < new Date()) {
    await userRef.update({ subscriptionStatus: 'free' });
    isPro = false;
  }

  const followUps = dreamData.followUps || [];

  if (!isPro && followUps.length >= 2) {
    throw new HttpsError('resource-exhausted', 'upgrade_required');
  }

  
  let conversationHistory = "";
  if (followUps.length > 0) {
    conversationHistory = "Previous follow-up questions and your answers:\n";
    followUps.forEach((f, i) => {
      conversationHistory += `Q: ${f.question}\nA: ${f.answer}\n\n`;
    });
  }

  const isHebrew = /[\u0590-\u05FF]/.test(dreamData.description) || /[\u0590-\u05FF]/.test(question);
  const langInstruction = isHebrew ? "\n\nIMPORTANT: You must output your ENTIRE reply exclusively in fluent, native Hebrew (RTL)." : "IMPORTANT: Output your response in the same language as the user's question.";

  const prompt = `You are a professional Jungian dream analyst and personal development coach.
The user previously shared the following dream:
"${dreamData.description}"

You previously analyzed it with:
"${dreamData.analysis}"

${conversationHistory}
The user now asks a follow-up question:
"${question.trim()}"

Provide a concise, helpful, and insightful response that directly addresses their question, tying back to their original dream imagery if relevant.
${langInstruction}`;

  let answer;
  try {
    answer = await callVertexAI(prompt);
  } catch (err) {
    console.error('Vertex AI follow-up error:', err.response?.data || err.message);
    throw new HttpsError('internal', 'AI analysis failed to reply. Please try again.');
  }

  const newFollowUp = {
    question: question.trim(),
    answer: answer.trim(),
    timestamp: new Date().toISOString()
  };

  await dreamRef.update({
    followUps: admin.firestore.FieldValue.arrayUnion(newFollowUp)
  });

  return { success: true, answer: answer.trim(), followUp: newFollowUp };
});

// ─── Sitemap Generator ────────────────────────────────────────────────────────

exports.sitemapXml = onRequest({ cors: true }, async (req, res) => {
  const domain = 'https://dream-analytics.com';
  
  // Base public routes
  const staticRoutes = [
    '',
    '/about.html',
    '/pricing.html',
    '/support.html',
    '/terms.html',
    '/privacy.html',
    '/freud.html',
    '/jung.html',
    '/he/',
    '/he/about.html',
    '/he/pricing.html',
    '/he/support.html',
    '/he/terms.html',
    '/he/privacy.html',
    '/he/freud.html',
    '/he/jung.html'
  ];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  const today = new Date().toISOString().split('T')[0];

  // Append static pages
  staticRoutes.forEach(route => {
    xml += '  <url>\n';
    xml += `    <loc>${domain}${route}</loc>\n`;
    xml += `    <lastmod>${today}</lastmod>\n`;
    xml += '    <changefreq>weekly</changefreq>\n';
    xml += '    <priority>0.8</priority>\n';
    xml += '  </url>\n';
  });

  // Future-proofing: We can dynamically query Firestore here for public articles or shared dreams.
  // const articlesRef = db.collection('articles').where('isPublic', '==', true);
  // const articlesSnap = await articlesRef.get();
  // articlesSnap.forEach(doc => { ... append <url> ... });

  xml += '</urlset>';

  res.set('Content-Type', 'text/xml');
  res.status(200).send(xml);
});

// ─── Health check ─────────────────────────────────────────────────────────────

exports.health = onRequest({ cors: true }, (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Pro video demo scheduled exports (re-export from pipeline) ───────────────
const { dreamPersonalDemoEN, dreamPersonalDemoHE } = require('./dreamVideoPipeline');
exports.dreamPersonalDemoEN = dreamPersonalDemoEN;
exports.dreamPersonalDemoHE = dreamPersonalDemoHE;

// ─── Social video automation ──────────────────────────────────────────────────
const dreamPipeline = require('./dreamVideoPipeline');
exports.dreamVideoMorning   = dreamPipeline.dreamVideoMorning;
exports.dreamVideoEvening   = dreamPipeline.dreamVideoEvening;
exports.triggerDreamVideo   = dreamPipeline.triggerDreamVideo;
exports.dreamIllustrationEN = dreamPipeline.dreamIllustrationEN;
exports.dreamIllustrationHE = dreamPipeline.dreamIllustrationHE;
exports.dreamFreudJungEN    = dreamPipeline.dreamFreudJungEN;
exports.dreamFreudJungHE    = dreamPipeline.dreamFreudJungHE;

// ─── DreamCoach Instagram CAROUSEL (daily rotating-theme image post) ─────────
const { postDreamCoachCarousel } = require('./dreamCoachCarousel');

// Note: GEMINI_API_KEY is read from functions/.env (already configured in this
// project for the dream video pipeline), not from Secret Manager — declaring
// it as a secret here would conflict with the .env value.
const CAROUSEL_SECRETS = [
  'DREAM_IG_USER_ID',
  'DREAM_IG_ACCESS_TOKEN',
  'REMOTION_AWS_ACCESS_KEY_ID',
  'REMOTION_AWS_SECRET_ACCESS_KEY',
  'DREAM_REMOTION_SERVE_URL',
  'DREAM_REMOTION_FUNCTION_NAME',
];

// Hebrew carousel — morning local
exports.dailyDreamCoachCarousel = onSchedule({
  schedule: '0 9 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'us-central1',
  timeoutSeconds: 540,
  memory: '1GiB',
  secrets: CAROUSEL_SECRETS,
}, async () => {
  const result = await postDreamCoachCarousel({ trigger: 'scheduled', language: 'he' });
  console.log('[dailyDreamCoachCarousel/he] result:', JSON.stringify(result));
});

// English carousel — afternoon IL = morning EST, lines up with US audience.
exports.dailyDreamCoachCarouselEN = onSchedule({
  schedule: '0 17 * * *',
  timeZone: 'Asia/Jerusalem',
  region: 'us-central1',
  timeoutSeconds: 540,
  memory: '1GiB',
  secrets: CAROUSEL_SECRETS,
}, async () => {
  const result = await postDreamCoachCarousel({ trigger: 'scheduled', language: 'en' });
  console.log('[dailyDreamCoachCarousel/en] result:', JSON.stringify(result));
});

// ─── DreamCoach AI CHARACTER VIDEO (manual only) ─────────────────────────────
// 50-second vertical story with an AI-generated person narrating a fresh dream
// and the DreamCoach AI orb delivering the interpretation. Hebrew uses Google
// Cloud TTS; English uses ElevenLabs.
const { postDreamCharacterVideo } = require('./dreamCharacterPipeline');

const CHARACTER_SECRETS = [
  'ELEVENLABS_API_KEY',
  'DREAM_REMOTION_SERVE_URL',
  'DREAM_REMOTION_FUNCTION_NAME',
  'REMOTION_AWS_ACCESS_KEY_ID',
  'REMOTION_AWS_SECRET_ACCESS_KEY',
  'ADMIN_SECRET_KEY',
  // Needed for the IG Reel + YouTube upload step at the end of the pipeline.
  'DREAM_IG_ACCESS_TOKEN',
  'DREAM_IG_USER_ID',
];

exports.triggerDreamCharacterVideo = onRequest({
  region: 'us-central1',
  timeoutSeconds: 3600,
  memory: '1GiB',
  secrets: CHARACTER_SECRETS,
  cors: ['https://www.dream-analytics.com', 'https://dream-analytics.com', 'https://dreamanalysis-39322.web.app'],
}, async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const language    = (req.body && req.body.language === 'en') ? 'en' : 'he';
  const archetypeId = (req.body && typeof req.body.archetypeId === 'string' && req.body.archetypeId.trim()) || undefined;
  try {
    const result = await postDreamCharacterVideo({ trigger: 'manual', language, archetypeId });
    if (!result.success) return res.status(500).json({ error: result.error || 'Pipeline failed', ...result });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// HTTP endpoint (admin only) — matches the x-admin-key pattern already used by
// triggerDreamVideo so the existing social-dashboard UI can call it the same way.
exports.triggerDreamCoachCarousel = onRequest({
  region: 'us-central1',
  timeoutSeconds: 540,
  memory: '1GiB',
  secrets: [...CAROUSEL_SECRETS, 'ADMIN_SECRET_KEY'],
  cors: ['https://www.dream-analytics.com', 'https://dream-analytics.com', 'https://dreamanalysis-39322.web.app'],
}, async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const themeId = (req.body && typeof req.body.themeId === 'string' && req.body.themeId.trim()) || undefined;
  const language = (req.body && req.body.language === 'en') ? 'en' : 'he';
  try {
    const result = await postDreamCoachCarousel({ trigger: 'manual', themeId, language });
    if (!result.success) return res.status(500).json({ error: result.error || 'Carousel failed', ...result });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});


// Opinly-powered public blog (SSR) - see blog.js
Object.assign(exports, require('./blog.js'));
