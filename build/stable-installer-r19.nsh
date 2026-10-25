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
  Delete "$SMPROGRAMS\LilacAnime Libmpv R2J Subtitle Fix.lnk"
  Delete "$DESKTOP\LilacAnime Libmpv R2J Subtitle Fix.lnk"
  Delete "$newStartMenuLink"
  CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  Delete "$newDesktopLink"
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
!macroend
