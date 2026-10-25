!include FileFunc.nsh

; R23 restores the assisted install-directory page. electron-builder normally
; sanitizes the directory with APP_FILENAME. Pin that token to the stable folder
; name so the default page shows D:\Program Files\LilacAnime-Libmpv and choosing
; a parent directory can never append the historical R2J/versioned folder name.
!ifndef allowToChangeInstallationDirectory
  !define allowToChangeInstallationDirectory
!endif
!ifdef APP_FILENAME
  !undef APP_FILENAME
!endif
!define APP_FILENAME "LilacAnime-Libmpv"

Function LilacCleanupDetachedR2J
  ReadEnvStr $R7 "LILAC_LEGACY_INSTALL_DIR"
  StrCmp $R7 "" 0 lilacLegacyPathReady
  StrCpy $R7 "D:\Program Files\LilacAnime-Libmpv-R2J-SubtitleFix"
lilacLegacyPathReady:
  StrCmp $R7 "$INSTDIR" lilacLegacyCleanupDone 0
  ${GetFileName} "$R7" $R6
  StrCmp $R6 "LilacAnime-Libmpv-R2J-SubtitleFix" 0 lilacLegacyCleanupDone
  IfFileExists "$R7\resources\app.asar" 0 lilacLegacyCleanupDone

  nsExec::ExecToLog 'taskkill.exe /F /T /IM "LilacAnime-Libmpv-R2J-SubtitleFix.exe"'
  Pop $R5
  Sleep 500
  RMDir /r "$R7"
  Sleep 350
  IfFileExists "$R7\resources\app.asar" 0 lilacLegacyCleanupDone

  nsExec::ExecToLog 'cmd.exe /d /c attrib -R -S -H "$R7\*" /S /D ^& rmdir /S /Q "$R7"'
  Pop $R5
  Sleep 750
  IfFileExists "$R7\resources\app.asar" 0 lilacLegacyCleanupDone

  MessageBox MB_OK|MB_ICONSTOP "기존 LilacAnime R2J 설치 폴더를 정리하지 못했습니다.$\r$\nLilacAnime 창을 모두 닫은 뒤 설치를 다시 실행해 주세요." /SD IDOK
  SetErrorLevel 2
  Quit
lilacLegacyCleanupDone:
FunctionEnd

!macro customInit
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R9 "" 0 lilacHaveExistingInstall
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
lilacHaveExistingInstall:
  StrCmp $R9 "" lilacChooseStableRoot 0
  ${GetFileName} "$R9" $R8
  StrCmp $R8 "LilacAnime-Libmpv" 0 lilacChooseStableRoot

  ; Existing canonical installation: prefill the page with its exact path.
  StrCpy $INSTDIR "$R9"
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
  ; Never inherit an old shortcut target. Recreate both links against this build.
  Delete "$SMPROGRAMS\LilacAnime Libmpv R2J Subtitle Fix.lnk"
  Delete "$DESKTOP\LilacAnime Libmpv R2J Subtitle Fix.lnk"
  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  Delete "$newDesktopLink"
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"

  ; Finish-page Run always opens the current executable directly.
  StrCpy $launchLink "$appExe"
  Call LilacCleanupDetachedR2J

  ; CI-only probes. Silent updates skip the directory page, while this records
  ; the exact final install/launch values selected by the installer.
  ReadEnvStr $R5 "LILAC_R23_INSTALLDIR_PROBE"
  StrCmp $R5 "" lilacInstallDirProbeDone
  FileOpen $R4 "$R5" w
  FileWrite $R4 "$INSTDIR"
  FileClose $R4
lilacInstallDirProbeDone:
  ReadEnvStr $R5 "LILAC_R23_LAUNCH_PROBE"
  StrCmp $R5 "" lilacLaunchProbeDone
  FileOpen $R4 "$R5" w
  FileWrite $R4 "$launchLink"
  FileClose $R4
lilacLaunchProbeDone:
!macroend
