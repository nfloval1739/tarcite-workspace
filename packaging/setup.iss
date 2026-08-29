; Inno Setup script for TarCite Workspace (Windows)
; Requires Inno Setup 6.3+ (for ArchitecturesInstallIn64BitMode=x64compatible):
;   https://jrsoftware.org/isinfo.php
; Run from the project root after PyInstaller:
;   iscc packaging\setup.iss
;
; To sign the installer, install your code signing certificate then uncomment
; the #define SIGNTOOL line below (or pass /DSIGNTOOL on the command line).
;
; Example with Standard (OV) certificate:
;   #define SIGNTOOL "signtool.exe sign /fd SHA256 /tr http://timestamp.digicert.com /td sha256 /n ""Naufal Naufal"" $f"
;
; Example with Azure Trusted Signing:
;   #define SIGNTOOL "AzureSignTool.exe sign -du ""TarCite Workspace"" -kvu https://your-vault.vault.azure.net/ -kvi xxx -kvs xxx -kvc your-cert -tr http://timestamp.digicert.com $f"

#define MyAppName "TarCite Workspace"
#define MyAppVersion "0.2.46"
#define MyAppDisplayVersion "v.02.46 (Nokilalaki Peak)"
#define MyAppPublisher "Naufal Naufal"
#define MyAppURL "https://tarcite.com"
#define MyAppExeName "TarCiteWorkspace.exe"
#define MyAppID "{{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}"

#ifndef SrcDir
  #define SrcDir "..\dist\TarCiteWorkspace"
#endif
#ifndef OutputBase
  #define OutputBase "TarCiteWorkspace-Setup"
#endif

[Setup]
AppId={#MyAppID}
AppName={#MyAppName}
AppVersion={#MyAppDisplayVersion}
VersionInfoVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
AppComments=Local-first academic citation assistant with AI-powered suggestion
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename={#OutputBase}
SetupIconFile=..\app\static\logo\favicon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
; The PyInstaller bundle is x64-only. x64compatible covers x64 and ARM64
; (which runs x64 under emulation); ArchitecturesAllowed stops setup on
; 32-bit x86 Windows with a clear message instead of a broken install.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ShowLanguageDialog=no

; Signing — uncomment the #define SIGNTOOL line at the top of this file
; or pass /DSIGNTOOL="..." on the iscc command line.
#ifdef SIGNTOOL
  SignTool=MySigner {#SIGNTOOL}
  SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startupicon"; Description: "Start TarCite Workspace when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startupicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallDelete]
; Only remove files we installed; leave user data (DB, ChromaDB, settings) intact
Type: filesandordirs; Name: "{app}\_internal"
Type: filesandordirs; Name: "{app}\models"
Type: filesandordirs; Name: "{app}\ollama"
Type: filesandordirs; Name: "{app}\ollama_models"
Type: filesandordirs; Name: "{app}\word-addin"
Type: filesandordirs; Name: "{app}\app"
Type: files; Name: "{app}\TarCiteWorkspace.exe"
Type: files; Name: "{app}\*.dll"
Type: files; Name: "{app}\*.pyd"
Type: files; Name: "{app}\*.manifest"
Type: files; Name: "{app}\*.ico"
Type: files; Name: "{app}\*.json"
Type: files; Name: "{app}\base_library.zip"
