## Miruro 인증 창 수정

- API가 Cloudflare 인증을 요구할 때 홈페이지 대신 실제 차단된 API 주소를 열도록 수정했습니다.
- 인증 페이지 로딩 실패와 시간 초과를 감지하고, 빈 창에서 계속 기다리지 않도록 오류를 안내합니다.
- 인증 후 API 응답이 파일 다운로드로 바뀌면 파일을 저장하지 않고 요청을 재확인합니다.
- Cloudflare가 인증 없이 접속 자체를 차단한 경우에는 인증 창을 열지 않고 차단 안내를 표시합니다.

이 수정은 인증 창과 오류 처리를 개선합니다. Miruro 측 접속 차단 자체를 해제하지는 않습니다.

검증: Miruro 세션·재생·복구 관련 테스트 16개 통과.

## 다운로드

- Windows: `LilacAnime-Setup.exe`
- Mac Apple Silicon: `LilacAnime-mac-arm64.dmg`
- Mac Intel: `LilacAnime-mac-x64.dmg`
