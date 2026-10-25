## Linux: .deb로 바뀜

- Linux는 이제 AppImage 대신 `.deb` 패키지로 배포합니다 (x64 · arm64). `sudo apt install ./LilacAnime-linux-amd64.deb`로 설치하면 앱 메뉴에 LilacAnime이 생깁니다.
- `.deb`는 Ubuntu 24.04 이상의 샌드박스(AppArmor) 설정까지 함께 설치해, AppImage가 열리지 않던 문제가 없습니다.
- 새 버전은 **설정 > 업데이트 · 정보**에서 **지금 설치**를 누르면 비밀번호를 물은 뒤 설치하고 다시 시작합니다.
- v0.5.53을 AppImage로 쓰고 있다면 자동 업데이트가 되지 않습니다. 아래 `.deb`를 받아 설치해 주세요.

## Miruro

- Miruro가 더 이상 Cloudflare 인증을 요구하지 않아, 인증 창과 관련 처리를 없앴습니다. 목록·회차·영상은 이전처럼 뒤에서 불러옵니다.

## 플레이어

- ←/→로 앞뒤로 넘긴 뒤 영상이 다시 재생될 때 컨트롤 바가 올라오던 문제를 고쳤습니다. 이제 처음 재생할 때와 일시정지 후 다시 재생할 때만 올라옵니다.

## 정리

- 앱 전체에 걸려 있던 새 창(팝업) 차단을 없앴습니다.
- 쓰이지 않던 별도 플레이어 창 기능을 없앴습니다.

## 검증

- 자동 테스트 277개 통과.
- 개발 빌드에서 회차 재생, Miruro 목록·회차·영상 주소, ←/→ 이동 후 컨트롤 바가 올라오지 않는 것과 일시정지·재생 동작 확인.
- GitHub Actions에서 Windows · Mac(Apple Silicon · Intel) · Linux `.deb`(x64 · arm64) 빌드 성공.

## 다운로드

- Windows: `LilacAnime-Setup.exe`
- Mac Apple Silicon: `LilacAnime-mac-arm64.dmg`
- Mac Intel: `LilacAnime-mac-x64.dmg`
- Linux x64: `LilacAnime-linux-amd64.deb`
- Linux arm64: `LilacAnime-linux-arm64.deb`
