# Sky CRM 웹 체험판

설치 없이 사용하는 정적 웹 체험판입니다. 통화 기록, 거래처 DB, 메모 탭에서
추가·수정·삭제할 수 있고, 메모를 할 일로 만들거나 완료 처리할 수 있습니다.
통화 기록의 `할 일로 추가`는 해당 내용을 메모 탭에 복사합니다.

기록은 현재 브라우저의 localStorage에 저장합니다. Python 앱의 데이터와 연동하거나
다른 기기와 동기화하지 않습니다. 공개 체험에서는 예시 정보를 사용하세요.
백엔드, 계정, API 키, 외부 라이브러리 CDN은 필요하지 않습니다.

## GitHub Pages 배포

1. `docs/`와 `.github/workflows/web-preview.yml` 변경을 GitHub 저장소 main에 반영합니다.
2. 저장소 Settings → Pages → Build and deployment → Source를 **GitHub Actions**로 설정합니다.
3. Actions에서 **Deploy web preview to GitHub Pages**를 실행합니다.
4. 성공한 실행의 `github-pages` 배포 URL을 열면 됩니다. 실제 URL은 실행 결과로 확인하세요.

이 설정은 웹 체험판만 배포하며 기존 Windows EXE 빌드 워크플로와 독립적입니다.
GitHub 계정/저장소 요금제에 따라 Pages 사용 가능 여부와 공개 범위가 달라질 수 있습니다.

로컬 개발 시 `python -m http.server 8000 --directory docs`로 정적 서버를 실행할 수 있습니다.
