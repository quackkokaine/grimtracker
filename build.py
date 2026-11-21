"""Builds the single-file site (index.html) from src/. Run: python3 build.py"""
from pathlib import Path
root = Path(__file__).parent
html = (root / "src/index.template.html").read_text()
html = html.replace("/*@GDSAVE@*/", (root / "src/gdsave.js").read_text()).replace("/*@GDDB@*/", (root / "src/gddb.js").read_text())
(root / "index.html").write_text(html)
print("built index.html")
