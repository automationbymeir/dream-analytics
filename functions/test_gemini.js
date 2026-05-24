const axios = require('axios');
async function run() {
  const apiKey = process.env.GEMINI_API_KEY;
  const prompt = `Generate one fascinating, scientifically accurate dream fact that most people don't know.
Make it compelling, 1-2 sentences max, easy to understand for a general audience.
Focus on neuroscience, psychology, or interesting phenomena. Do NOT include quotation marks.
Just output the fact text only, nothing else.`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 150, temperature: 0.9 },
  };
  const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, body, { headers: { "Content-Type": "application/json" } });
  console.log(res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim());
}
run();
