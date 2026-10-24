## Miruro 연결 수정

- Miruro API를 전용 브라우저 페이지 안에서 요청하도록 변경했습니다. 쿠키를 공유해도 직접 요청은 Cloudflare 403으로 차단되던 문제를 수정했습니다.
- 요청 페이지를 재사용하고, 앱 창을 닫으면 숨겨진 요청 창도 정리합니다.
- 인증이 필요한 경우 차단된 API 주소를 열며, 접속 차단·로딩 실패·시간 초과를 안내합니다.

검증: 새 세션에서 인기순·평점순 목록 각 15개, 작품 상세, 회차 39개, 영상 서버 트랙 3개를 실제 조회했습니다. 관련 자동 테스트 18개를 통과했습니다. 실제 영상 재생은 이번 검증에 포함하지 않았습니다.

## 다운로드

- Windows: `LilacAnime-Setup.exe`
- Mac Apple Silicon: `LilacAnime-mac-arm64.dmg`
- Mac Intel: `LilacAnime-mac-x64.dmg`
