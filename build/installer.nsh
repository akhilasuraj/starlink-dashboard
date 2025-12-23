; Custom NSIS script for Starlink Dashboard installer
; This script adds the application to Windows startup registry

!macro customInstall
  ; Add to startup registry for current user
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StarlinkDashboard" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  
  ; Copy Python dependency installer and checker scripts
  SetOutPath "$INSTDIR"
  File "${BUILD_RESOURCES_DIR}\setup-python-deps.bat"
  File "${BUILD_RESOURCES_DIR}\check-dependencies.bat"
  
  ; Prompt user to install Python dependencies
  MessageBox MB_YESNO "Do you want to install Python dependencies now?$\n$\nThis requires Python 3.7+ to be installed.$\nYou can run 'setup-python-deps.bat' later if you skip this step." IDYES install_deps IDNO skip_deps
  
  install_deps:
    ExecWait '"$INSTDIR\setup-python-deps.bat"'
    Goto done
  
  skip_deps:
    MessageBox MB_OK "Remember to run 'setup-python-deps.bat' from the installation folder before using the application.$\n$\nYou can also use 'check-dependencies.bat' to verify your setup."
  
  done:
!macroend

!macro customUnInstall
  ; Remove from startup registry
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StarlinkDashboard"
  
  ; Delete the setup scripts
  Delete "$INSTDIR\setup-python-deps.bat"
  Delete "$INSTDIR\check-dependencies.bat"
!macroend
