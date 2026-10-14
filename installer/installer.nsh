; Explorer context menu: the app writes its own entries (see
; src/main/shellmenu.js); the uninstaller removes them.

!macro customInstall
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --register-shell'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\JanusDiff.1Compare"
  DeleteRegKey HKCU "Software\Classes\*\shell\JanusDiff.2Select"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\JanusDiff.1Compare"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\JanusDiff.2Select"
  DeleteRegKey HKCU "Software\Classes\*\shell\JanusDiff.3Selected"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\JanusDiff.3Selected"
!macroend
