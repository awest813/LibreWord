#!/bin/sh
# Regenerates the LibreOffice-written RTF fixtures from the sources in src/.
# Needs pandoc and LibreOffice (soffice) on the PATH.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
cp src/* "$tmp"
(cd "$tmp" && pandoc sample.md -o sample.docx && pandoc sample.md -o sample.odt)
soffice --headless --convert-to rtf --outdir "$tmp/docx" "$tmp/sample.docx" >/dev/null
soffice --headless --convert-to rtf --outdir "$tmp/odt" "$tmp/sample.odt" >/dev/null
soffice --headless --convert-to 'rtf:Rich Text Format' --outdir "$tmp" "$tmp/fmt.html" >/dev/null
cp "$tmp/docx/sample.rtf" libreoffice-from-docx.rtf
cp "$tmp/odt/sample.rtf" libreoffice-from-odt.rtf
cp "$tmp/fmt.rtf" libreoffice-from-html.rtf
rm -r "$tmp"
