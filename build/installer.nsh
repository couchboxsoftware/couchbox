; Extra uninstall step: remove the "Couchbox > Copy / Move to Couchbox" entries from File
; Explorer's right-click menu (written per user by src/main/shell-menu.js). An update reinstalls
; and Couchbox writes them again when it starts, so removing them here is always safe.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mp4\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mkv\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.avi\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mov\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.wmv\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.m4v\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.webm\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.ts\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mpg\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.mpeg\shell\Couchbox"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.flv\shell\Couchbox"
!macroend
