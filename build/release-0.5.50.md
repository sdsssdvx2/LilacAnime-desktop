## Miruro Cloudflare 인증 대응

- Miruro API 요청을 앱 전용 브라우저 세션으로 전환했습니다.
- Cloudflare 인증이 필요하면 인증 창이 열립니다. 직접 인증을 완료하면 같은 세션으로 요청을 다시 시도합니다.
- 인증 세션은 앱을 다시 시작해도 유지됩니다.
- 여러 요청이 동시에 차단되어도 인증 창은 하나만 표시합니다. 창을 닫거나 인증 시간이 초과되면 요청을 중단하고, 반복해서 창이 열리지 않도록 잠시 대기합니다.

Cloudflare 정책에 따라 내장 브라우저의 인증이 실패할 수 있습니다. 실제 인증 통과는 보장하지 않습니다.

검증: Miruro 세션·재생·복구 관련 테스트 13개 통과.

## 다운로드

- Windows: `LilacAnime-Setup.exe`
- Mac Apple Silicon: `LilacAnime-mac-arm64.dmg`
- Mac Intel: `LilacAnime-mac-x64.dmg`
