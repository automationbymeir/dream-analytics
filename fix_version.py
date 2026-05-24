import os
import re

public_dir = '/Users/meir.horwitz/Documents/dream-analytics/public'

for filename in os.listdir(public_dir):
    if filename.endswith('.html'):
        filepath = os.path.join(public_dir, filename)
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Add or update cache buster
        new_content = re.sub(r'mobile-nav\.js(\?v=\d+)?', 'mobile-nav.js?v=2', content)
        
        if content != new_content:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"Busted cache in {filename}")
