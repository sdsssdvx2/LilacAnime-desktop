!macro customInit
  ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R9 "" 0 lilacHaveExistingInstall
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
lilacHaveExistingInstall:
  StrCmp $R9 "" lilacChooseStableRoot 0
  ${GetFileName} "$R9" $R8
  StrCmp $R8 "LilacAnime-Libmpv" lilacStableInitDone lilacChooseStableRoot
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

  ; R18/R19 can encounter a detached legacy R2J folder after registry migration.
  ; Remove only the exact known legacy app folder and only when it still contains an Electron app payload.
  ReadEnvStr $R7 "LILAC_LEGACY_INSTALL_DIR"
  StrCmp $R7 "" 0 lilacLegacyReady
  StrCpy $R7 "D:\Program Files\LilacAnime-Libmpv-R2J-SubtitleFix"
lilacLegacyReady:
  StrCmp $R7 "$INSTDIR" lilacLegacyDone 0
  ${GetFileName} "$R7" $R6
  StrCmp $R6 "LilacAnime-Libmpv-R2J-SubtitleFix" 0 lilacLegacyDone
  IfFileExists "$R7\resources\app.asar" 0 lilacLegacyDone
  nsExec::ExecToLog 'taskkill.exe /F /IM "LilacAnime-Libmpv-R2J-SubtitleFix.exe"'
  Pop $R5
  RMDir /r "$R7"
lilacLegacyDone:
!macroend
