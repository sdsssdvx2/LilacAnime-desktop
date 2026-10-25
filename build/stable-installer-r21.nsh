!include FileFunc.nsh

Var /GLOBAL lilacDetachedLegacyCleanup

Function LilacCleanupDetachedR2J
  ReadEnvStr $R7 "LILAC_LEGACY_INSTALL_DIR"
  StrCmp $R7 "" 0 lilacLegacyPathReady
  StrCpy $R7 "D:\Program Files\LilacAnime-Libmpv-R2J-SubtitleFix"
lilacLegacyPathReady:
  StrCmp $R7 "$INSTDIR" lilacLegacyCleanupDone 0
  ${GetFileName} "$R7" $R6
  StrCmp $R6 "LilacAnime-Libmpv-R2J-SubtitleFix" 0 lilacLegacyCleanupDone
  IfFileExists "$R7\resources\app.asar" 0 lilacLegacyCleanupDone

  ; Kill the exact legacy app process tree first. R20 tried this only immediately
  ; before RMDir and never checked whether deletion actually succeeded.
  nsExec::ExecToLog 'taskkill.exe /F /T /IM "LilacAnime-Libmpv-R2J-SubtitleFix.exe"'
  Pop $R5
  Sleep 500
  RMDir /r "$R7"
  Sleep 350
  IfFileExists "$R7\resources\app.asar" 0 lilacLegacyCleanupDone

  ; One fallback through cmd handles delayed handles/attributes, then verify.
  nsExec::ExecToLog 'cmd.exe /d /c attrib -R -S -H "$R7\*" /S /D ^& rmdir /S /Q "$R7"'
  Pop $R5
  Sleep 750
  IfFileExists "$R7\resources\app.asar" 0 lilacLegacyCleanupDone

  ; Do not report a successful migration while the executable that caused the
  ; user's stale-launch failure is still physically present.
  MessageBox MB_OK|MB_ICONSTOP "기존 LilacAnime R2J 설치 폴더를 정리하지 못했습니다.$\r$\nLilacAnime 창을 모두 닫은 뒤 설치를 다시 실행해 주세요." /SD IDOK
  SetErrorLevel 2
  Quit
lilacLegacyCleanupDone:
FunctionEnd

!macro customInit
  StrCpy $lilacDetachedLegacyCleanup "0"
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R9 "" 0 lilacHaveExistingInstall
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
lilacHaveExistingInstall:
  StrCmp $R9 "" lilacChooseStableRoot 0
  ${GetFileName} "$R9" $R8
  StrCmp $R8 "LilacAnime-Libmpv" 0 lilacChooseStableRoot

  ; The canonical install is already registered. This is the exact state seen
  ; after R18-R20 where a detached R2J folder may still survive separately.
  StrCpy $INSTDIR "$R9"
  StrCpy $lilacDetachedLegacyCleanup "1"
  Call LilacCleanupDetachedR2J
  Goto lilacStableInitDone

lilacChooseStableRoot:
  ReadEnvStr $0 "LILAC_INSTALL_ROOT"
  StrCmp $0 "" 0 lilacStableRootReady
  IfFileExists "D:\*.*" 0 lilacStableUseLocal
  StrCpy $0 "D:\Program Files"
  Goto lilacStableRootReady
lilacStableUseLocal:
  StrCpy $0 "$LOCALAPPDATA\Programs"
lilacStableRootReady:
  StrCpy $INSTDIR "$0\LilacAnime-Libmpv"
lilacStableInitDone:
!macroend

!macro customInstall
  ; Always recreate canonical shortcuts against the current installed executable.
  Delete "$SMPROGRAMS\LilacAnime Libmpv R2J Subtitle Fix.lnk"
  Delete "$DESKTOP\LilacAnime Libmpv R2J Subtitle Fix.lnk"
  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  Delete "$newDesktopLink"
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"

  ; electron-builder computes $launchLink before customInstall. Force the Finish
  ; page Run action to bypass any stale/cached .lnk and open the canonical EXE.
  StrCpy $launchLink "$appExe"

  ; First-time R2J -> stable migrations are handled by electron-builder's old
  ; uninstaller. Retry guarded cleanup afterwards in case a detached copy remains.
  Call LilacCleanupDetachedR2J

  ; Qualification-only probe: proves the actual Finish-page launch variable is
  ; the canonical app EXE without launching Electron on the CI runner.
  ReadEnvStr $R5 "LILAC_R21_LAUNCH_PROBE"
  StrCmp $R5 "" lilacLaunchProbeDone
  FileOpen $R4 "$R5" w
  FileWrite $R4 "$launchLink"
  FileClose $R4
lilacLaunchProbeDone:
!macroend
