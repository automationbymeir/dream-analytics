import os
import re

public_dir = '/Users/meir.horwitz/Documents/dream-analytics/public'
script_tag = '  <script src="/js/mobile-nav.js" type="module"></script>\n'

for filename in os.listdir(public_dir):
    if filename.endswith('.html'):
        filepath = os.path.join(public_dir, filename)
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        if 'mobile-nav.js' not in content:
            # Insert script tag before </body>
            new_content = re.sub(r'</body>', f'{script_tag}</body>', content, flags=re.IGNORECASE)
            
            # Write back
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)
        print(f"Processed {filename}")
