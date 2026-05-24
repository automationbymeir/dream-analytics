const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

async function run() {
  const doc = await db.collection('social_posts').doc('1779550537715-fact-en').get();
  console.log("===============================");
  console.log("FACT IN DB:");
  console.log(doc.data().fact);
  console.log("===============================");
}
run().catch(console.error).then(() => process.exit(0));
