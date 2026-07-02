; Triboon.iss - Inno Setup script for the Triboon Windows server installer.
;
; Do NOT compile this by hand. Run installer\windows\build-installer.ps1, which downloads the
; Node runtime + ffmpeg/yt-dlp/alass, stages the payload, and invokes ISCC with the two defines
; this script expects:  /DAppVersion=<x.y.z>  /DStageDir=<abs path to staging\app>
;
; The produced Triboon-Setup-vX.Y.Z.exe:
;   - installs to Program Files\Triboon (read-only app payload),
;   - registers "Triboon" as an auto-start Windows service via the bundled WinSW wrapper,
;   - opens the LAN firewall for node.exe on the private+domain profiles only (never public),
;   - keeps all user data under C:\ProgramData\Triboon across upgrades AND uninstall,
;   - offers to open http://localhost:7777 in the default browser when finished.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "staging\app"
#endif

#define AppName "Triboon"
#define AppPublisher "Triboon"
#define ServiceExe "triboon-service.exe"

[Setup]
; A fixed AppId (never change it) is what lets a new version detect and upgrade the old install.
AppId={{B7C3A1E4-2F6D-4B9A-8E15-7C8D2F4A1B60}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\Triboon
DefaultGroupName=Triboon
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=Triboon-Setup-v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Managing the SCM (service) and the firewall requires an elevated install.
PrivilegesRequired=admin
MinVersion=10.0
UninstallDisplayIcon={app}\node.exe
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Dirs]
; User data + logs under ProgramData. uninsneveruninstall keeps the encrypted settings, watch
; state and library DB when the user uninstalls or upgrades.
Name: "{commonappdata}\Triboon"; Flags: uninsneveruninstall
Name: "{commonappdata}\Triboon\data"; Flags: uninsneveruninstall
; Service log dir inside the app tree (written by LocalSystem, removed with the app).
Name: "{app}\logs"

[Run]
; ONLY the browser-open lives in [Run]: it needs the postinstall checkbox on the Finished page, and
; explorer.exe re-dispatches the URL as the logged-in (non-elevated) user. Service registration, the
; firewall rule, and the data-dir ACL run in [Code] (CurStepChanged) instead, so their exit codes are
; actually checked - an exit-code-blind [Run] entry would report a broken install as "success".
Filename: "{win}\explorer.exe"; Parameters: "http://localhost:7777"; Flags: postinstall nowait skipifsilent; Description: "Open Triboon in your browser"

[UninstallRun]
; Runs before file deletion, while the wrapper exe still exists. Each entry needs a unique RunOnceId.
Filename: "{app}\{#ServiceExe}"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopTriboonSvc"
Filename: "{app}\{#ServiceExe}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveTriboonSvc"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Triboon Server"""; Flags: runhidden waituntilterminated; RunOnceId: "DelTriboonFwRule"

[Code]
const
  SERVICE_NAME = 'Triboon';
  SVC_EXE = 'triboon-service.exe';

function AppFile(const n: String): String;
begin
  Result := ExpandConstant('{app}') + '\' + n;
end;

// sc query returns 1060 (ERROR_SERVICE_DOES_NOT_EXIST) only when the service is fully gone.
function ServiceExists(): Boolean;
var rc: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'query ' + SERVICE_NAME, '', SW_HIDE, ewWaitUntilTerminated, rc);
  Result := (rc <> 1060);
end;

// sc query's exit code can't distinguish stopped vs running, so read its text output.
function ServiceRunning(): Boolean;
var tmp: String; rc: Integer; s: AnsiString;
begin
  tmp := ExpandConstant('{tmp}\triboon-svcq.txt');
  Exec(ExpandConstant('{cmd}'), '/c sc query ' + SERVICE_NAME + ' > "' + tmp + '"', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Result := LoadStringFromFile(tmp, s) and (Pos('RUNNING', s) > 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var rc, i: Integer;
begin
  NeedsRestart := False;
  Result := '';
  if not ServiceExists() then exit;   // fresh install: nothing to stop/remove
  // Upgrade/reinstall: the running service locks node.exe + the wrapper exe, so [Files] would fail
  // to overwrite them. Stop + delete BEFORE any file is copied (PrepareToInstall runs pre-copy;
  // sc.exe is always in {sys}).
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop ' + SERVICE_NAME, '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{sys}\sc.exe'), 'delete ' + SERVICE_NAME, '', SW_HIDE, ewWaitUntilTerminated, rc);
  // sc delete only MARKS the service for deletion; the SCM keeps the record until every open handle
  // (services.msc, a monitoring agent) closes. Poll until it's truly gone so the re-install below
  // can't hit ERROR_SERVICE_MARKED_FOR_DELETE (1072) and silently fail.
  for i := 1 to 30 do    // ~15s bounded
  begin
    if not ServiceExists() then exit;
    Sleep(500);
  end;
  Result := 'Windows is still removing the previous Triboon service (a Services or Task Manager window may be holding it open). Please close those windows and run the installer again.';
end;

// ProgramData grants BUILTIN\Users read on inherited content, and NTFS ignores the server's POSIX
// 0600 file mode, so secret.json (the token-signing key) would be readable by any local user. Break
// inheritance and grant Full only to SYSTEM (the LocalSystem service account) + Administrators.
procedure HardenDataDir();
var rc: Integer;
begin
  Exec(ExpandConstant('{sys}\icacls.exe'),
    '"' + ExpandConstant('{commonappdata}\Triboon') + '" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C /Q',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
end;

// Allow inbound to node.exe on private + domain profiles only (never public). Delete-then-add keeps
// it idempotent so upgrades don't stack duplicate rules.
procedure OpenFirewall();
var rc: Integer;
begin
  Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Triboon Server"', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{sys}\netsh.exe'),
    'advfirewall firewall add rule name="Triboon Server" dir=in action=allow program="' + ExpandConstant('{app}\node.exe') + '" enable=yes profile=private,domain',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var rc, i: Integer;
begin
  if CurStep <> ssPostInstall then exit;

  HardenDataDir();
  OpenFirewall();

  // Register the service. Failure here = no service at all, so hard-stop with a clear message
  // instead of the exit-code-blind [Run] section reporting a false success.
  if (not Exec(AppFile(SVC_EXE), 'install', '', SW_HIDE, ewWaitUntilTerminated, rc)) or (rc <> 0) then
    RaiseException('Could not register the Triboon Windows service (code ' + IntToStr(rc) + ').' + #13#10 +
      'Close services.msc / Task Manager and re-run the installer. Details in ' + ExpandConstant('{app}\logs') + '.');

  // Start it, then confirm it actually reached RUNNING (WinSW start can return 0 while node later
  // crashes on boot). A start failure is not fatal - it is set to start automatically - but tell the
  // user rather than pretending all is well.
  Exec(AppFile(SVC_EXE), 'start', '', SW_HIDE, ewWaitUntilTerminated, rc);
  for i := 1 to 20 do    // ~10s
  begin
    if ServiceRunning() then break;
    Sleep(500);
  end;
  if not ServiceRunning() then
    MsgBox('Triboon was installed but has not started yet. This usually means port 7777 is already in use, ' +
      'or Windows will start it shortly (it is set to start automatically).' + #13#10 + #13#10 +
      'Try http://localhost:7777 in a minute; logs are in ' + ExpandConstant('{app}\logs') + '.', mbInformation, MB_OK);
end;
