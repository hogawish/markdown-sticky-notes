!macro NSIS_HOOK_POSTINSTALL
  Push $0
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --register-chrome-host' $0
  ${If} $0 <> 0
    DetailPrint "Chrome native host registration failed. Existing registration was not replaced."
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "Chrome tab links could not be registered. See the Chrome setup instructions in the project repository."
  ${EndIf}
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    Push $0
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --unregister-chrome-host' $0
    Pop $0
  ${EndIf}
!macroend
