
#define MyAppName "LUZYX"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Lucky"

[Setup]
AppId={{B47A1C52-81F0-4A27-9E53-6D1C8F7B20A4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\LUZYX
DefaultGroupName=LUZYX
OutputDir=installer_output
OutputBaseFilename=LUZYX-Setup
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "dist\LUZYX\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\LUZYX"; Filename: "{app}\LUZYX.exe"
Name: "{autodesktop}\LUZYX"; Filename: "{app}\LUZYX.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\LUZYX.exe"; Description: "Launch LUZYX"; Flags: postinstall nowait skipifsilent
