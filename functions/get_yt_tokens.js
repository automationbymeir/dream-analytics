// One-time script to generate YouTube OAuth tokens for DreamCoach.
// Run ONCE from the functions/ folder:
//   node get_yt_tokens.js
//
// Prerequisites:
//   - dreamcoach_yt_secret.json must exist in this folder (downloaded from GCP)
//   - npm install googleapis (already in package.json)
//
// What it does:
//   1. Prints an auth URL — open it in your browser
//   2. Sign in as the owner of the @DreamCoach-j3o channel
//   3. Paste the authorization code back here
//   4. Saves dreamcoach_yt_tokens.json — the pipeline reads this automatically

const { google } = require("googleapis");
const readline   = require("readline");
const fs         = require("fs");
const path       = require("path");

const SECRET_PATH = path.join(__dirname, "dreamcoach_yt_secret.json");
const TOKEN_PATH  = path.join(__dirname, "dreamcoach_yt_tokens.json");

if (!fs.existsSync(SECRET_PATH)) {
  console.error("\n❌  dreamcoach_yt_secret.json not found in functions/");
  console.error("    Download it from GCP → APIs & Services → Credentials\n");
  process.exit(1);
}

const { web } = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
const oauth2 = new google.auth.OAuth2(
  web.client_id,
  web.client_secret,
  "https://developers.google.com/oauthplayground"
);

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",   // force refresh_token to be returned
});

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🌙  DreamCoach YouTube OAuth Setup");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
console.log("1️⃣   Open this URL in your browser:\n");
console.log("    " + authUrl);
console.log("\n2️⃣   Sign in with the Google account that owns @DreamCoach-j3o");
console.log("3️⃣   After authorising, you will be redirected to OAuth Playground");
console.log("    — copy the 'code' parameter from the URL or the page\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Paste the authorization code here: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2.getToken(code.trim());
    oauth2.setCredentials(tokens);

    // Verify by fetching channel info
    const youtube  = google.youtube({ version: "v3", auth: oauth2 });
    const response = await youtube.channels.list({ part: ["snippet"], mine: true });
    const channel  = response.data.items?.[0]?.snippet?.title;

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log("\n✅  Tokens saved to dreamcoach_yt_tokens.json");
    console.log(`🎉  Authorised channel: "${channel}"`);
    console.log("\nYou're done — the pipeline will use these tokens automatically.\n");
  } catch (err) {
    console.error("\n❌  Error exchanging code:", err.message);
    console.error("    Make sure you copied the full code and try again.\n");
    process.exit(1);
  }
});
