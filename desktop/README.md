# Sky CRM Windows

현재 `docs/` 웹 앱을 Electron에 포함한 Windows 10/11 x64 실행 파일입니다.
실행에 Python, 브라우저 설치, 인터넷 연결은 필요하지 않습니다.

실행 파일은 GitHub Releases의 `SkyCRM-1.1.1-Windows-x64.exe`입니다.
`%APPDATA%\SkyCRM`에 localStorage와 IndexedDB를 저장합니다. EXE 교체나 실행 위치 변경으로 데이터가 바뀌지 않도록 고정된 `skycrm://app` origin을 사용합니다.
기존 Python 앱의 JSON과 백업을 열고 저장할 수 있습니다. 다른 PC에서는 데이터 파일을 선택하거나 FTP에서 불러옵니다. 웹 체험판과 자동 동기화하지는 않습니다.
앱을 종료한 뒤 해당 폴더 전체를 복사하면 데이터 백업이 가능합니다. `파일 → 데이터 저장 폴더 열기`로 확인할 수 있습니다.

## 빌드와 확인

Windows에서 Node.js 22와 Python 3을 준비한 뒤 저장소 루트에서 실행합니다.

```powershell
python .github/scripts/build-desktop.py --commit local
npm --prefix desktop ci
npm --prefix .github/tests ci
npm --prefix desktop run pack
python -m pip install pyftpdlib==2.2.0
node .github/tests/storage.cjs
node .github/tests/desktop.cjs
node .github/tests/desktop-files.cjs
npm --prefix desktop run dist
```

`desktop/out/SkyCRM-1.1.1-Windows-x64.exe`가 생성됩니다. Windows 워크플로는 패키징된 앱에서 오프라인 로딩, 저장 후 재실행, 이미지/첨부파일 보존을 확인한 뒤 EXE와 SHA-256 체크섬을 Release에 업로드합니다.
Windows 코드 서명 인증서는 포함하지 않으므로 게시자 확인 안내가 표시될 수 있습니다.

다음 배포에서는 `package.json` 버전과 릴리스 안내의 파일명을 함께 변경합니다.
기존 Python 앱 빌드와 GitHub Pages 배포는 별도로 유지합니다.

## 기존 데이터와 FTP

- 상단 파일 도구 또는 파일 메뉴에서 기존 JSON과 `.bak1`·`.bak2`·`.bak3` 파일을 엽니다. 오래된 통화 기록은 날짜 필터를 비워 모두 표시합니다.
- 저장 시 이전 파일을 3개 순환 백업하고, 임시 파일에 완전히 기록한 뒤 교체합니다. 현재 파일 손상 시 백업을 미리보기로 열며 손상 파일은 별도 `.corrupt-...` 사본으로 보존합니다.
- 복구 미리보기는 Ctrl+S 전까지 현재 파일에 자동 저장하지 않습니다. 파일을 바꾸기 전에 수정 내용을 저장합니다.
- 환경설정에서 하드디스크 / FTP / 하드디스크+FTP 방식, 저장 폴더, 파일명, 서버/포트/계정/비밀번호/경로/FTPS와 동기화 간격을 지정합니다. 기존 `call_settings_lite.json`을 가져올 수도 있습니다.
- FTP 파일 목록에서 원본 또는 백업을 선택합니다. 처음 사용하는 기존 서버 파일은 반드시 먼저 불러와야 업로드할 수 있습니다. FTP 방식은 시작할 때 서버 파일을 가져오며, 실패 시 PC 캐시가 있으면 안내 후 엽니다.
- 자동 저장은 PC에 먼저 적용하고 FTP는 설정 간격·수동 저장·종료 시 동기화합니다. FTP 오류로 PC 저장본을 삭제하지 않습니다. 서버 파일 변경을 감지하면 덮어쓰기를 거절합니다. 종료 시 실패하면 재시도·PC 저장본으로 종료·취소를 선택할 수 있습니다.
- FTP 업로드는 임시 파일을 완전히 전송하고 원본을 보존한 뒤 교체하며 서버에도 `.bak1`~`.bak3`를 보관합니다. 일반 FTP와 명시적 FTPS(TLS)를 지원합니다. SFTP 방식은 지원하지 않습니다.
- 비밀번호는 Windows의 `safeStorage`로 암호화하여 `desktop-storage.json`에 저장하고, 렌더러에는 제한된 IPC만 노출합니다. 디스크/FTP 작업은 메인 프로세스에서 순차 실행합니다.
- 저장 파일은 기존의 `clients` 사전, `calls`, `memo_tasks_v1`을 유지합니다. 새 페이지/서식/이미지/첨부 바이트는 `_skycrm` 메타데이터에 함께 보관합니다. 원본의 알 수 없는 최상위 키와 거래처 추가 필드도 보존합니다.
- 테스트는 임시 폴더와 루프백 FTP 서버만 사용하며 사용자 서버/데이터에 연결하지 않습니다.
