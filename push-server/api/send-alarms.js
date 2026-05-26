const admin = require('firebase-admin');
const webpush = require('web-push');

let initialised = false;
function db() {
  if (!initialised) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    initialised = true;
  }
  return admin.firestore();
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const secret = req.query.secret || req.headers['x-cron-secret'] ||
    (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '');
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const firestore = db();
  const now = admin.firestore.Timestamp.now();

  // Fetch alarms due now that haven't been sent yet
  const snap = await firestore.collection('scheduledAlarms')
    .where('dueAt', '<=', now)
    .get();

  const due = snap.docs.filter(d => !d.data().sent);
  if (!due.length) return res.status(200).json({ sent: 0 });

  // Batch-fetch push subscriptions for each unique userId
  const userIds = [...new Set(due.map(d => d.data().userId))];
  const subDocs = await Promise.all(userIds.map(uid => firestore.collection('pushSubscriptions').doc(uid).get()));
  const subMap = {};
  subDocs.forEach((s, i) => { if (s.exists) subMap[userIds[i]] = s.data().subscription; });

  let sent = 0;
  const batch = firestore.batch();

  await Promise.all(due.map(async docSnap => {
    const alarm = docSnap.data();
    const subscription = subMap[alarm.userId];
    if (!subscription) return;

    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: '⏰ TaskFlow',
        body: alarm.title + (alarm.description ? ' — ' + alarm.description : ''),
        taskId: alarm.taskId,
      }));
      sent++;
      // Mark alarm sent and update the task so the app shows the overlay on next open
      batch.update(docSnap.ref, { sent: true, sentAt: admin.firestore.FieldValue.serverTimestamp() });
      const taskRef = firestore.collection('users').doc(alarm.userId).collection('tasks').doc(alarm.taskId);
      batch.update(taskRef, { alarmTriggered: true });
    } catch (e) {
      console.error('[push] taskId=%s status=%s', alarm.taskId, e.statusCode);
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Subscription expired — remove it so we don't keep trying
        batch.delete(firestore.collection('pushSubscriptions').doc(alarm.userId));
      }
    }
  }));

  await batch.commit();
  res.status(200).json({ sent, total: due.length });
};
