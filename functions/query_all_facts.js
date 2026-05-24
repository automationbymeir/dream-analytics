const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

async function run() {
  const snap = await db.collection('social_posts').orderBy('createdAt', 'desc').limit(5).get();
  snap.forEach(doc => {
    console.log("===============================");
    console.log("ID:", doc.id);
    console.log("FACT:", doc.data().fact);
  });
}
run().catch(console.error).then(() => process.exit(0));
