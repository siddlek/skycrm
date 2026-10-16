"""Bundle the current web UI, including offline dependencies, into the desktop app."""
import argparse
import runpy
import sys
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--commit', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
output = root / 'desktop' / 'assets'
sys.argv = ['build-pages.py', str(output), '--commit', args.commit]
runpy.run_path(str(root / '.github/scripts/build-pages.py'), run_name='__main__')
index = output / 'index.html'
html = index.read_text(encoding='utf-8')
html = html.replace('준비 완료 · 이 브라우저에 자동 저장됩니다.', '준비 완료 · 이 PC에 자동 저장됩니다.')
html = html.replace('웹 버전 · 데이터는 이 브라우저에만 저장되며 데스크톱 앱과 자동 연동되지 않습니다.', 'Windows 버전 · 선택한 JSON 파일에 저장합니다. 기존 데이터·백업·FTP는 파일 메뉴에서 열 수 있습니다.')
html = html.replace('</head>', '<link rel="stylesheet" href="desktop-ui.css"></head>')
html = html.replace('</body>', '<script src="desktop-ui.js"></script></body>')
for name in ('desktop-ui.js', 'desktop-ui.css'):
    shutil.copyfile(root / 'desktop' / name, output / name)
index.write_text(html, encoding='utf-8')
