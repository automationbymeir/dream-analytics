const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();

// ─── Configuration ────────────────────────────────────────────────────────────
// Keys are read from Firebase Functions config:
//   firebase functions:config:set gemini.key="..." paypal.client_id="..." paypal.secret="..."
// For local dev, create functions/.runtimeconfig.json with the same structure.

const cfg = () => functions.config();

const GEMINI_API_KEY  = () => (cfg().gemini  && cfg().gemini.key)         || process.env.GEMINI_API_KEY;
const PAYPAL_CLIENT   = () => (cfg().paypal  && cfg().paypal.client_id)   || process.env.PAYPAL_CLIENT_ID   || 'AfFO713UgKTXBPuyY7SKC9pQ_o3aJBSCA7h1WVdoRbYGcqXwfhuyII1FZz2AHRV9LIb3UEXY_0BTPw6f';
const PAYPAL_SECRET   = () => (cfg().paypal  && cfg().paypal.secret)      || process.env.PAYPAL_SECRET       || 'EII7K42SQr_St07G1WfgY7AqyU3VxyYuL8W-mxbe9ZNAfMbF1oxk2en9rjw-QhfeHh8vPjTLebgppPDw';
const PAYPAL_BASE_URL = 'https://api-m.paypal.com'; // Switch to api-m.sandbox.paypal.com for testing

const FREE_TIER_LIMIT = 3; // analyses per month

// ─── Jungian Prompts (ported from original DreamCoach) ────────────────────────
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function ensureUserDoc(uid, authToken) {
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      email: authToken.email || '',
      displayName: authToken.name || authToken.email || '',
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

exports.analyzeDream = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required.');
  }

  const uid = context.auth.uid;
  const { description, dreamDate, name } = data;

  if (!description || description.trim().length < 20) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a fuller dream description (at least 20 characters).');
  }

  // Ensure user document exists
  const userRef = await ensureUserDoc(uid, context.auth.token);
  const userSnap = await userRef.get();
  const user = userSnap.data();

  // ── Subscription & usage check ───────────────────────────────────────────
  const isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
  if (isPro && user.subscriptionExpiry && user.subscriptionExpiry.toDate() < new Date()) {
    // Subscription expired — downgrade
    await userRef.update({ subscriptionStatus: 'free' });
    isPro = false;
  }

  const monthKey = currentMonthKey();
  let usage = user.monthlyUsage || 0;

  if ((user.monthlyUsageReset || '') !== monthKey) {
    // New month — reset counter
    usage = 0;
    await userRef.update({ monthlyUsage: 0, monthlyUsageReset: monthKey });
  }

  if (!isPro && usage >= FREE_TIER_LIMIT) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Free tier limit of ${FREE_TIER_LIMIT} analyses/month reached. Upgrade to Pro for unlimited access.`
    );
  }

  // ── Gemini API call ──────────────────────────────────────────────────────
  const apiKey = GEMINI_API_KEY();
  if (!apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API not configured.');
  }

  let analysis;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    const prompt = `${JUNGIAN_PROMPT}\n\n${ALT_PROMPT}\n\nDream to analyze:\n"${description.trim()}"`;
    const result = await model.generateContent(prompt);
    analysis = result.response.text();
  } catch (err) {
    console.error('Gemini error:', err);
    throw new functions.https.HttpsError('internal', 'AI analysis failed. Please try again.');
  }

  // ── Save dream to Firestore ──────────────────────────────────────────────
  const dreamRef = await db.collection('dreams').add({
    userId: uid,
    name: name || context.auth.token.name || '',
    email: context.auth.token.email || '',
    dreamDate: dreamDate || new Date().toISOString().split('T')[0],
    description: description.trim(),
    analysis,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  // ── Increment usage ──────────────────────────────────────────────────────
  await userRef.update({
    monthlyUsage: admin.firestore.FieldValue.increment(1)
  });

  const remaining = isPro ? null : Math.max(0, FREE_TIER_LIMIT - usage - 1);

  return {
    success: true,
    dreamId: dreamRef.id,
    analysis,
    remainingFree: remaining
  };
});

// ─── analyzeDreamTrends (Pro only) ───────────────────────────────────────────

exports.analyzeDreamTrends = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required.');
  }

  const uid = context.auth.uid;
  const { prompt: userPrompt, dateFrom, dateTo } = data;

  if (!userPrompt || userPrompt.trim().length < 5) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide an analysis prompt.');
  }

  // Check Pro subscription
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'User profile not found.');
  }
  const user = userSnap.data();
  const isPro = ['pro_monthly', 'pro_yearly'].includes(user.subscriptionStatus);
  if (!isPro || (user.subscriptionExpiry && user.subscriptionExpiry.toDate() < new Date())) {
    throw new functions.https.HttpsError('permission-denied', 'Trend analysis requires a Pro subscription.');
  }

  // Fetch dreams within date range
  let query = db.collection('dreams').where('userId', '==', uid);
  if (dateFrom) query = query.where('dreamDate', '>=', dateFrom);
  if (dateTo)   query = query.where('dreamDate', '<=', dateTo);
  query = query.orderBy('dreamDate', 'desc').limit(50);

  const snap = await query.get();
  if (snap.empty) {
    throw new functions.https.HttpsError('not-found', 'No dreams found in the specified date range.');
  }

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
  if (!apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Gemini API not configured.');
  }

  let analysis;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const result = await model.generateContent(systemPrompt);
    analysis = result.response.text();
  } catch (err) {
    console.error('Gemini trend error:', err);
    throw new functions.https.HttpsError('internal', 'Trend analysis failed. Please try again.');
  }

  return {
    success: true,
    dreamCount: snap.size,
    dateRange: `${dateFrom || 'all time'} to ${dateTo || 'today'}`,
    analysis
  };
});

// ─── verifyPayPalSubscription ─────────────────────────────────────────────────

exports.verifyPayPalSubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required.');
  }

  const uid = context.auth.uid;
  const { subscriptionId, planType } = data; // planType: 'monthly' | 'yearly'

  if (!subscriptionId || !planType) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing subscriptionId or planType.');
  }

  try {
    const token = await getPayPalToken();

    // Fetch subscription details from PayPal
    const res = await axios.get(
      `${PAYPAL_BASE_URL}/v1/billing/subscriptions/${subscriptionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const sub = res.data;

    if (sub.status !== 'ACTIVE') {
      throw new functions.https.HttpsError('failed-precondition', `Subscription status is ${sub.status}, not ACTIVE.`);
    }

    // Calculate expiry
    const now = new Date();
    const expiry = new Date(now);
    if (planType === 'yearly') {
      expiry.setFullYear(expiry.getFullYear() + 1);
    } else {
      expiry.setMonth(expiry.getMonth() + 1);
      expiry.setDate(expiry.getDate() + 2); // small grace period
    }

    const status = planType === 'yearly' ? 'pro_yearly' : 'pro_monthly';

    await db.doc(`users/${uid}`).update({
      subscriptionStatus: status,
      subscriptionId,
      subscriptionExpiry: admin.firestore.Timestamp.fromDate(expiry)
    });

    return { success: true, status, expiry: expiry.toISOString() };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error('PayPal verify error:', err.response?.data || err.message);
    throw new functions.https.HttpsError('internal', 'Failed to verify subscription with PayPal.');
  }
});

// ─── setupPayPalPlans (call once to create plans in PayPal dashboard) ─────────

exports.setupPayPalPlans = functions.https.onRequest(async (req, res) => {
  // Protect with a simple secret query param
  if (req.query.secret !== 'dreamcoach-setup-2024') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const token = await getPayPalToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 1. Create product
    const productRes = await axios.post(`${PAYPAL_BASE_URL}/v1/catalogs/products`, {
      name: 'DreamCoach Pro',
      description: 'Unlimited dream analyses, trend analysis, and insights.',
      type: 'SERVICE',
      category: 'SOFTWARE'
    }, { headers });
    const productId = productRes.data.id;
    console.log('Product ID:', productId);

    // 2. Create monthly plan
    const monthlyRes = await axios.post(`${PAYPAL_BASE_URL}/v1/billing/plans`, {
      product_id: productId,
      name: 'DreamCoach Pro – Monthly',
      description: 'Unlimited dream analyses billed monthly.',
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: '20.00', currency_code: 'USD' } }
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: '0', currency_code: 'USD' },
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3
      }
    }, { headers });
    const monthlyPlanId = monthlyRes.data.id;

    // 3. Create yearly plan
    const yearlyRes = await axios.post(`${PAYPAL_BASE_URL}/v1/billing/plans`, {
      product_id: productId,
      name: 'DreamCoach Pro – Yearly',
      description: 'Unlimited dream analyses billed annually (save 20%).',
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'YEAR', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: '192.00', currency_code: 'USD' } }
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: '0', currency_code: 'USD' },
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3
      }
    }, { headers });
    const yearlyPlanId = yearlyRes.data.id;

    // 4. Store plan IDs in Firestore for the frontend to read
    await db.doc('config/paypal').set({
      productId,
      monthlyPlanId,
      yearlyPlanId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, productId, monthlyPlanId, yearlyPlanId });
  } catch (err) {
    console.error('Setup error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── paypalWebhook (registered in PayPal dashboard) ──────────────────────────

exports.paypalWebhook = functions.https.onRequest(async (req, res) => {
  const event = req.body;
  const eventType = event.event_type;
  const subscriptionId = event.resource?.id || event.resource?.billing_agreement_id;

  console.log('PayPal webhook:', eventType, subscriptionId);

  try {
    if (!subscriptionId) {
      return res.status(200).send('OK – no subscription ID');
    }

    // Find user with this subscription ID
    const usersSnap = await db.collection('users')
      .where('subscriptionId', '==', subscriptionId)
      .limit(1)
      .get();

    if (usersSnap.empty) {
      console.log('No user found for subscription:', subscriptionId);
      return res.status(200).send('OK – user not found');
    }

    const userRef = usersSnap.docs[0].ref;

    switch (eventType) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await userRef.update({ subscriptionStatus: 'pro_monthly' });
        break;

      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED': {
        // Downgrade immediately on cancellation/expiry
        await userRef.update({
          subscriptionStatus: 'free',
          subscriptionId: null,
          subscriptionExpiry: null
        });
        break;
      }

      case 'PAYMENT.SALE.COMPLETED': {
        // Extend expiry by one billing cycle
        const userSnap = await userRef.get();
        const user = userSnap.data();
        const currentExpiry = user.subscriptionExpiry
          ? user.subscriptionExpiry.toDate()
          : new Date();
        const newExpiry = new Date(Math.max(currentExpiry, new Date()));
        if (user.subscriptionStatus === 'pro_yearly') {
          newExpiry.setFullYear(newExpiry.getFullYear() + 1);
        } else {
          newExpiry.setMonth(newExpiry.getMonth() + 1);
        }
        await userRef.update({
          subscriptionExpiry: admin.firestore.Timestamp.fromDate(newExpiry)
        });
        break;
      }

      default:
        console.log('Unhandled event type:', eventType);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    // Return 200 so PayPal doesn't retry endlessly
    res.status(200).send('OK – internal error logged');
  }
});

// ─── cancelSubscription ───────────────────────────────────────────────────────

exports.cancelSubscription = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Login required.');
  }

  const uid = context.auth.uid;
  const userSnap = await db.doc(`users/${uid}`).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found.');
  }

  const { subscriptionId } = userSnap.data();
  if (!subscriptionId) {
    throw new functions.https.HttpsError('not-found', 'No active subscription found.');
  }

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
    throw new functions.https.HttpsError('internal', 'Failed to cancel subscription.');
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────

exports.health = functions.https.onRequest((req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
