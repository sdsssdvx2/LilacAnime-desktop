## 광고 팝업 차단

- 외부 영상 서버와 숨겨진 영상 주소 탐색 창을 포함해, 웹페이지가 새 창·새 탭으로 여는 팝업을 차단합니다.
- iframe에서 여는 팝업도 차단합니다.
- 앱이 직접 여는 재생·인증 창과 기존 권한 처리는 유지합니다.
- 페이지 안에 표시되는 광고는 이번 변경 대상에 포함하지 않습니다.

## 검증

- 관련 자동 테스트 21개 통과.
- 실제 Electron에서 새 창·새 탭·iframe 팝업 차단과 앱 자체 창 열기 확인.
- Miruro 두 작품의 영상 서버 조회 및 1080p HLS 영상 조각 3개 버퍼링 성공.
- FlixCloud HD-1에서 재생목록·키 수신과 실제 재생 시간 진행 확인.
- 위 실제 사이트 테스트에서 새 광고 창 0개.

## 다운로드

- Windows: `LilacAnime-Setup.exe`
- Mac Apple Silicon: `LilacAnime-mac-arm64.dmg`
- Mac Intel: `LilacAnime-mac-x64.dmg`
