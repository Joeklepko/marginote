; Put marginote-cli.exe on the current user's PATH and cleanly remove it on
; uninstall. No administrator permission is required (currentUser install).
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"
!ifndef StrStr_INCLUDED
  ${StrStr}
!endif
!ifndef UnStrRep_INCLUDED
  ${UnStrRep}
!endif

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 ";$0;"
  StrCpy $2 ";$INSTDIR;"
  ${StrStr} $3 $1 $2
  ${If} $3 == ""
    ${If} $0 == ""
      StrCpy $0 "$INSTDIR"
    ${Else}
      StrCpy $0 "$0;$INSTDIR"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 ";$0;"
  ${UnStrRep} $1 $1 ";$INSTDIR;" ";"
  ${If} $1 == ";"
    StrCpy $1 ""
  ${Else}
    StrLen $2 $1
    IntOp $2 $2 - 2
    StrCpy $1 $1 $2 1
  ${EndIf}
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
