# Sky CRM Windows

현재 `docs/` 웹 앱을 Electron에 포함한 Windows 10/11 x64 실행 파일입니다.
실행에 Python, 브라우저 설치, 인터넷 연결은 필요하지 않습니다.

실행 파일은 GitHub Releases의 `SkyCRM-1.0.0-Windows-x64.exe`입니다.
`%APPDATA%\SkyCRM`에 localStorage와 IndexedDB를 저장합니다. EXE 교체나 실행 위치 변경으로 데이터가 바뀌지 않도록 고정된 `skycrm://app` origin을 사용합니다.
다른 사용자 계정/PC, 웹 체험판, 기존 Python 앱과는 자동 연동하지 않습니다.
앱을 종료한 뒤 해당 폴더 전체를 복사하면 데이터 백업이 가능합니다. `파일 → 데이터 저장 폴더 열기`로 확인할 수 있습니다.

## 빌드와 확인

Windows에서 Node.js 22와 Python 3을 준비한 뒤 저장소 루트에서 실행합니다.

```powershell
python .github/scripts/build-desktop.py --commit local
npm --prefix desktop ci
npm --prefix .github/tests ci
npm --prefix desktop run pack
node .github/tests/desktop.cjs
npm --prefix desktop run dist
```

`desktop/out/SkyCRM-1.0.0-Windows-x64.exe`가 생성됩니다. Windows 워크플로는 패키징된 앱에서 오프라인 로딩, 저장 후 재실행, 이미지/첨부파일 보존을 확인한 뒤 EXE와 SHA-256 체크섬을 Release에 업로드합니다.
Windows 코드 서명 인증서는 포함하지 않으므로 게시자 확인 안내가 표시될 수 있습니다.

다음 배포에서는 `package.json` 버전과 릴리스 안내의 파일명을 함께 변경합니다.
기존 Python 앱 빌드와 GitHub Pages 배포는 별도로 유지합니다.
