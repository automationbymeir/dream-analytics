const admin = require("firebase-admin");
async function go() {
  const db = admin.firestore();
  const snap = await db.collection("social_posts").orderBy("createdAt", "desc").limit(5).get();
  console.log("=== RESULTS ===");
  snap.forEach(doc => {
    console.log(doc.id, " => ", doc.data().fact);
  });
  console.log("=== DONE ===");
}
go();
