; Custom NSIS hooks for Racemo installer
; Kill racemo-server.exe before install so the binary can be replaced

!macro NSIS_HOOK_PREINSTALL
  nsis_tauri_utils::KillProcess "racemo-server.exe"
  Pop $R0
  Sleep 500
!macroend
