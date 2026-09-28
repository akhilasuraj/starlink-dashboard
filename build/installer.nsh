; Custom NSIS script for Starlink Dashboard installer
; Startup is opt-in from the installed application's settings.

!macro customUnInstall
  ; Remove from startup registry
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StarlinkDashboard"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.starlink.dashboard"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "StarlinkDashboard"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.starlink.dashboard"
  
!macroend
