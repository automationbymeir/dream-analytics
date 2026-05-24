// Thin lazy-loader for @google/genai (lets us share carousel code with the
// trendingtech-daily codebase without changing the call sites).
let _GoogleGenAI = null;

async function loadGeminiSDK() {
  if (_GoogleGenAI) return true;
  try {
    const mod = require('@google/genai');
    _GoogleGenAI = mod.GoogleGenAI;
    return !!_GoogleGenAI;
  } catch (err) {
    console.error('Failed to load @google/genai:', err.message);
    return false;
  }
}

function getGeminiSDK() {
  return { GoogleGenAI: _GoogleGenAI };
}

module.exports = { loadGeminiSDK, getGeminiSDK };
