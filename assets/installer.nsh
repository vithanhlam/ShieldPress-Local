; ── Pre-install: backup portable.txt before old version is removed ────────────
!macro customInit
  ; Save portable.txt to TEMP so it survives the uninstall of the previous version
  IfFileExists "$INSTDIR\portable.txt" 0 +2
    CopyFiles /SILENT "$INSTDIR\portable.txt" "$TEMP\shieldpress_portable_backup.txt"
!macroend

; ── Post-install: restore portable.txt and system setup ──────────────────────
!macro customInstall
  ; Grant Users write access to hosts file (required for .local domain resolution)
  nsExec::ExecToLog 'icacls "$WINDIR\System32\drivers\etc\hosts" /grant Users:M'

  ; Restore portable.txt (Data Directory path) after new files are extracted
  ; customInstall runs AFTER extraction — this is the correct place for restore
  IfFileExists "$TEMP\shieldpress_portable_backup.txt" 0 +3
    CopyFiles /SILENT "$TEMP\shieldpress_portable_backup.txt" "$INSTDIR\portable.txt"
    Delete "$TEMP\shieldpress_portable_backup.txt"

  ; PHP 8.4/8.5 (VS17) need the 2015-2022 x64 runtime. Install quietly when
  ; the machine has no VC++ 14 runtime, or an older build than 14.40.
  StrCpy $0 0
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Bld"
  IntCmpU $0 32000 _sp_vc_ok _sp_vc_install _sp_vc_ok
  _sp_vc_install:
    IfFileExists "$INSTDIR\resources\vc_redist.x64.exe" 0 _sp_vc_ok
      DetailPrint "Installing Microsoft Visual C++ Redistributable (x64)..."
      ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart' $1
      DetailPrint "Visual C++ Redistributable exit code $1"
  _sp_vc_ok:
!macroend

; ── Uninstall: offer to remove workspace data ─────────────────────────────────
!macro customUnInstall
  IfFileExists "C:\ShieldPress_Project\*.*" 0 _sp_check_d
    MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to remove all ShieldPress Local data?$\n$\nC:\ShieldPress_Project$\n$\nThis will permanently delete all projects, databases, backups, and configurations." IDYES _sp_remove_c IDNO _sp_check_d
    _sp_remove_c:
      RMDir /r "C:\ShieldPress_Project"

  _sp_check_d:
  IfFileExists "D:\ShieldPress_Project\*.*" 0 _sp_check_e
    MessageBox MB_YESNO|MB_ICONQUESTION "Remove ShieldPress Local data on D: drive?$\n$\nD:\ShieldPress_Project" IDYES _sp_remove_d IDNO _sp_check_e
    _sp_remove_d:
      RMDir /r "D:\ShieldPress_Project"

  _sp_check_e:
  IfFileExists "E:\ShieldPress_Project\*.*" 0 _sp_check_f
    MessageBox MB_YESNO|MB_ICONQUESTION "Remove ShieldPress Local data on E: drive?$\n$\nE:\ShieldPress_Project" IDYES _sp_remove_e IDNO _sp_check_f
    _sp_remove_e:
      RMDir /r "E:\ShieldPress_Project"

  _sp_check_f:
  IfFileExists "F:\ShieldPress_Project\*.*" 0 _sp_cleanup_done
    MessageBox MB_YESNO|MB_ICONQUESTION "Remove ShieldPress Local data on F: drive?$\n$\nF:\ShieldPress_Project" IDYES _sp_remove_f IDNO _sp_cleanup_done
    _sp_remove_f:
      RMDir /r "F:\ShieldPress_Project"

  _sp_cleanup_done:
!macroend
