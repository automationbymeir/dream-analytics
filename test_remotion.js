const { renderMedia, selectComposition } = require("@remotion/renderer");
const path = require("path");

async function run() {
  const bundleLocation = path.join(__dirname, "video-generator/src/index.ts");
  
  // This is a fast API to evaluate a composition locally
  // We can't easily render a full video without a bundle, but we CAN use getCompositions
  
  // Wait, I can just use remotion CLI to extract a frame!
}
run();
