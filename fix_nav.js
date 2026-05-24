const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));

files.forEach(file => {
  const filePath = path.join(publicDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Skip if we already added a hamburger menu
  if (content.includes('id="mobile-menu-btn"')) return;

  // Let's add the global mobile script tag before </body>
  if (!content.includes('mobile-nav.js')) {
    content = content.replace('</body>', '  <script src="/js/mobile-nav.js"></script>\n</body>');
  }

  // We need to ensure the main links container in nav is hidden on mobile
  // and has an id so mobile-nav.js can grab it easily.
  // There are two common patterns in the codebase:
  // 1. <div class="hidden md:flex items-center gap-4...
  // 2. <div class="hidden md:flex items-center gap-5...
  // 3. <div class="flex items-center gap-5"> (in index.html)
  
  // To standardize, let's inject a hamburger button inside the <nav> 
  // right next to the logout or 'Get Started' button.
  // We'll let mobile-nav.js dynamically find the links by grabbing the first div inside nav that contains multiple <a> tags.
  
  fs.writeFileSync(filePath, content, 'utf-8');
});
console.log('updated html files');
