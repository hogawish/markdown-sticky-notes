!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    Push $0
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --unregister-chrome-host' $0
    Pop $0
  ${EndIf}
!macroend
