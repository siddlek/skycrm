"""Build the static preview with content-addressed assets to avoid stale JS/CSS."""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("--commit", required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[2] / "docs"
args.output.mkdir(parents=True, exist_ok=True)
html = (source / "index.html").read_text(encoding="utf-8")
for filename in ("style.css", "columns.js", "app.js", "assets.js", "rich-text.js", "memos.js"):
    content = (source / filename).read_bytes()
    digest = hashlib.sha256(content).hexdigest()[:16]
    path = Path(filename)
    target = f"{path.stem}.{digest}{path.suffix}"
    (args.output / target).write_bytes(content)
    html = re.sub(re.escape(filename) + r'(?:\?[^"\s]*)?', target, html)
shutil.copytree(source / "vendor", args.output / "vendor", dirs_exist_ok=True)
(args.output / "index.html").write_text(html, encoding="utf-8")
(args.output / "robots.txt").write_bytes((source / "robots.txt").read_bytes())
(args.output / "version.json").write_text(
    json.dumps({"commit": args.commit}, indent=2), encoding="utf-8"
)
print(f"Built Pages artifact for {args.commit}")
