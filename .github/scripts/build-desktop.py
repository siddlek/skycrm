"""Bundle the current web UI, including offline dependencies, into the desktop app."""
import argparse
import runpy
import sys
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
html = html.replace('웹 버전 · 데이터는 이 브라우저에만 저장되며 데스크톱 앱과 자동 연동되지 않습니다.', 'Windows 버전 · 데이터는 이 PC에 저장되며 웹 체험판·기존 Python 앱과 자동 연동되지 않습니다.')
index.write_text(html, encoding='utf-8')
