; Startup is opt-in from the installed application's settings.
!macro customUnInstall
  ; An upgrade must preserve the user's preference. Only a real uninstall removes it.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StarlinkDashboard"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.starlink.dashboard"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "StarlinkDashboard"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.starlink.dashboard"
  ${endIf}
!macroend
