#!/bin/sh
# Rebuild the .doc fixtures from src/*.html with LibreOffice, plus the
# synthetic compressed-piece variants and LibreOffice's own text of the
# fixtures that the tests cross-check against.
set -e
cd "$(dirname "$0")"
# The long fixture (>64 KB of UTF-16 text, several FKP pages) is generated.
python3 - <<'PY'
import random
random.seed(1)
words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split()
out = ['<html><head><meta charset="utf-8"><title>Long Document</title></head><body>']
for i in range(240):
    s = ' '.join(random.choice(words) for _ in range(28))
    if i % 7 == 3: out.append(f'<p>Para {i}: <b>{s[:40]}</b> {s[40:]} é</p>')
    elif i % 11 == 5: out.append(f'<h2>Section {i}</h2>')
    else: out.append(f'<p>Para {i}: {s}.</p>')
out.append('<p>THE END</p></body></html>')
open('src/long.html', 'w').write('\n'.join(out))
PY
soffice --headless --infilter="HTML (StarWriter)" --convert-to 'doc:MS Word 97' --outdir . src/*.html
python3 make-pieces.py pieces.doc pieces-512.doc 512
python3 make-pieces.py pieces.doc pieces-4k.doc 4096
rm -rf src/long.html __pycache__
soffice --headless --convert-to 'txt:Text (encoded):UTF8' --outdir . long.doc pieces-512.doc
