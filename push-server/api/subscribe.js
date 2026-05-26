const admin = require('firebase-admin');

let initialised = false;
function db() {
  if (!initialised) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    initialised = true;
  }
  return admin.firestore();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, subscription } = req.body || {};
  if (!userId || !subscription?.endpoint) return res.status(400).json({ error: 'Missing userId or subscription' });

  try {
    await db().collection('pushSubscriptions').doc(userId).set({
      subscription,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[subscribe]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
};
