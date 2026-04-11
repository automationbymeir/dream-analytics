const admin = require('firebase-admin');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();

// ─── Configuration ────────────────────────────────────────────────────────────
// Keys loaded from functions/.env (Firebase v2 picks this up automatically).

const GEMINI_API_KEY  = () => process.env.GEMINI_API_KEY;
const PAYPAL_CLIENT   = () => process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET   = () => process.env.PAYPAL_SECRET;
const PAYPAL_BASE_URL = 'https://api-m.paypal.com';

const FREE_TIER_LIMIT = 3;

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

exports.analyzeDream = onCall({ cors: true }, async (request) => {
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

  // Gemini API call
  const apiKey = GEMINI_API_KEY();
  if (!apiKey) throw new HttpsError('failed-precondition', 'Gemini API not configured.');

  let analysis;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const prompt = `${JUNGIAN_PROMPT}\n\n${ALT_PROMPT}\n\nDream to analyze:\n"${description.trim()}"`;
    const result = await model.generateContent(prompt);
    analysis = result.response.text();
  } catch (err) {
    console.error('Gemini error:', err);
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

  const remaining = isPro ? null : Math.max(0, FREE_TIER_LIMIT - usage - 1);
  return { success: true, dreamId: dreamRef.id, analysis, remainingFree: remaining };
});

// ─── analyzeDreamTrends (Pro only) ───────────────────────────────────────────

exports.analyzeDreamTrends = onCall({ cors: true }, async (request) => {
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

  const systemPrompt = `You are an expert dream analyst specializing in identifying patterns across multiple dream journal entries.
Analyze the following dreams based on the user's request. Identify key recurring elements, symbols, archetypes, and psychological themes.
Structure your response clearly with sections for Key Themes, Detailed Analysis, and Insights for Personal Growth.

User's analysis request: "${userPrompt.trim()}"

Dreams to analyze:
${dreams.join('\n\n')}`;

  const apiKey = GEMINI_API_KEY();
  if (!apiKey) throw new HttpsError('failed-precondition', 'Gemini API not configured.');

  let analysis;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const result = await model.generateContent(systemPrompt);
    analysis = result.response.text();
  } catch (err) {
    console.error('Gemini trend error:', err);
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
    await db.doc(`users/${uid}`).update({
      subscriptionStatus: status,
      subscriptionId,
      subscriptionExpiry: admin.firestore.Timestamp.fromDate(expiry)
    });

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

// ─── Health check ─────────────────────────────────────────────────────────────

exports.health = onRequest({ cors: true }, (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
