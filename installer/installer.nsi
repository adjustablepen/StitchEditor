; Stitch Editor - Windows installer (per-user, no admin needed, so the built-in updater can write to it)
; Built by tools/build-installer.sh:  makensis -DVERSION=x.y.z -DSRC=<unpacked "Stitch Editor" folder> -DOUT=<setup.exe> installer.nsi
Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define APP "Stitch Editor"
!define EXE "Stitch Editor.exe"
!define PUBLISHER "adjustapen"
!define URL "https://github.com/adjustablepen/StitchEditor"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\StitchEditor"

Name "${APP}"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${UNKEY}" "InstallLocation"
BrandingText "${APP} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} Setup"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "© ${PUBLISHER}"

!define MUI_ICON "installer.ico"
!define MUI_UNICON "installer.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "welcome.bmp"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install ${APP} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP} - an image and template editor with a live 3D preview.$\r$\n$\r$\nNo administrator rights are needed. ${APP} keeps itself up to date from GitHub.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP} now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Add a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION DesktopShortcut
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; close a running copy first (otherwise its files are locked)
!macro CloseApp
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${EXE}" /NH | find /I "${EXE}"'
  Pop $0
  ${If} $0 == 0
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "${APP} is open. Click OK to close it and continue." IDOK +2
    Abort
    nsExec::Exec 'taskkill /IM "${EXE}" /F'
    Sleep 1200
  ${EndIf}
!macroend

Function LaunchApp
  Exec '"$INSTDIR\${EXE}"'
FunctionEnd
Function DesktopShortcut
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${APP}.ico" 0
FunctionEnd

Section "Install"
  SetShellVarContext current
  !insertmacro CloseApp
  ; clean out an older copy of the app files, keep nothing stale
  RMDir /r "$INSTDIR\resources\app"
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  File "/oname=$INSTDIR\Stitch Editor.ico" "installer.ico"
  WriteUninstaller "$INSTDIR\Uninstall ${APP}.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${APP}.ico" 0

  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNKEY}" "URLInfoAbout" "${URL}"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\${APP}.ico"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall ${APP}.exe"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall ${APP}.exe" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro CloseApp
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNKEY}"
  ; remove only what we installed (safe even if the folder was shared with other files)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\Stitch Editor.exe"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\${APP}.ico"
  Delete "$INSTDIR\Uninstall ${APP}.exe"
  RMDir "$INSTDIR"
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Stitch Editor settings and autosaved work?" /SD IDNO IDNO +2
  RMDir /r "$APPDATA\${APP}"
SectionEnd
