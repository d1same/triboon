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
; Triboon logo everywhere Windows shows an icon: the setup .exe itself + the Apps & features /
; Add-Remove-Programs entry (was pointing at node.exe, which showed the Node.js logo).
UninstallDisplayIcon={app}\triboon.ico
SetupIconFile=triboon.ico
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; Triboon logo, installed alongside the app so the uninstall entry + Start Menu shortcut can use it.
Source: "triboon.ico"; DestDir: "{app}"; Flags: ignoreversion
; Tray helper (a system-tray icon so the background service is visible + reachable in one click).
Source: "triboon-tray.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "triboon-tray.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The server is a background service (no app window), so the branded Start Menu entry just opens the
; dashboard in the browser. explorer.exe re-dispatches the URL as the logged-in user.
Name: "{group}\Open Triboon"; Filename: "{win}\explorer.exe"; Parameters: "http://localhost:7777"; IconFilename: "{app}\triboon.ico"; Comment: "Open the Triboon dashboard"
; Tray icon: launched at login (Startup) + a manual Start Menu entry. wscript runs the .vbs, which
; starts the tray PowerShell hidden (no console). Kept per-user so it isn't forced on every account.
Name: "{userstartup}\Triboon Tray"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\triboon-tray.vbs"""; IconFilename: "{app}\triboon.ico"; Comment: "Triboon server tray icon"
Name: "{group}\Triboon Tray Icon"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\triboon-tray.vbs"""; IconFilename: "{app}\triboon.ico"; Comment: "Show the Triboon tray icon"
Name: "{group}\Uninstall Triboon"; Filename: "{uninstallexe}"

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
; Show the tray icon now (via explorer so it runs de-elevated as the logged-in user, matching the
; Startup entry; without this the tray only appears at next login).
Filename: "{win}\explorer.exe"; Parameters: """{app}\triboon-tray.vbs"""; Flags: postinstall nowait skipifsilent; Description: "Show the Triboon tray icon"

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

// Belt-and-suspenders: before an upgrade, snapshot the small top-level state files (encrypted settings,
// the token-signing secret, user accounts, watch history) to data-backup. The upgrade never touches the
// data dir (it lives in ProgramData, flagged keep-on-uninstall AND is not in the [Files] payload), so
// this is pure insurance — a last-known-good the owner can restore by hand. No /S so it skips the large,
// regenerable thumbs / subcache / tmdb-cache subdirs — the backup stays fast and small.
procedure BackupData();
var rc: Integer; data, backup: String;
begin
  data := ExpandConstant('{commonappdata}\Triboon\data');
  backup := ExpandConstant('{commonappdata}\Triboon\data-backup');
  if not DirExists(data) then exit;
  // robocopy exit codes 0..7 are success; run best-effort — a backup hiccup must never block the upgrade.
  Exec(ExpandConstant('{sys}\robocopy.exe'),
    '"' + data + '" "' + backup + '" /COPY:DAT /PURGE /R:1 /W:1 /NP /NFL /NDL /NJH /NJS',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
end;

// Stop the per-user tray helper (wscript running triboon-tray.vbs → powershell running the .ps1) so
// nothing holds a handle on the app dir while we replace it. Targeted by command-line match — never a
// blanket wscript/powershell kill. Best-effort: the tray is cosmetic and restarts on next login/finish.
procedure StopTray();
var rc: Integer;
begin
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ''*triboon-tray*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
end;

// Clean install of the PROGRAM FILES payload on upgrade: delete the fully-replaced code dirs so no
// stale file from a previous version lingers (the owner's "make sure files actually get overwritten").
// Runs only after the service is confirmed stopped (node.exe unlocked). It ONLY touches {app}
// code dirs — the data dir lives in ProgramData and is never referenced here, and {app}\logs +
// any legacy stray data ({app}\data / {app}\%ProgramData%) are left for MigrateStrayData to recover.
procedure CleanAppPayload();
begin
  DelTree(ExpandConstant('{app}\server'), True, True, True);
  DelTree(ExpandConstant('{app}\web'), True, True, True);
  DelTree(ExpandConstant('{app}\bin'), True, True, True);
end;

// Belt-and-suspenders for the data path: rewrite the INSTALLED service config so TRIBOON_DATA is a
// LITERAL absolute path ({commonappdata}\Triboon\data, resolved by Inno) instead of the %ProgramData%
// token. This removes all dependence on WinSW/env expanding the variable — data lands in the
// kept-on-upgrade ProgramData dir no matter what. (The server also expands %VAR% at runtime; this
// makes the packaged config correct at the source too.)
procedure WriteServiceDataPath();
var xmlPath: String; raw: AnsiString; content: String;
begin
  xmlPath := AppFile('triboon-service.xml');
  if not LoadStringFromFile(xmlPath, raw) then exit;
  content := raw;
  StringChangeEx(content, '%ProgramData%\Triboon\data', ExpandConstant('{commonappdata}\Triboon\data'), True);
  SaveStringToFile(xmlPath, content, False);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var rc, i: Integer;
begin
  NeedsRestart := False;
  Result := '';
  if not ServiceExists() then exit;   // FRESH INSTALL: no prior service → nothing to stop/clean; [Files] just lays down the payload and [Dirs] creates the (empty) ProgramData data dir.
  // UPGRADE path from here down. User data lives in ProgramData and is NEVER touched by any of this.
  BackupData();                        // snapshot config to data-backup before anything else
  StopTray();                          // stop the per-user tray so it can't hold an app-dir handle
  // The running service locks node.exe + the wrapper exe, so [Files] would fail to overwrite them.
  // Stop + delete BEFORE any file is copied (PrepareToInstall runs pre-copy; sc.exe is always in {sys}).
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop ' + SERVICE_NAME, '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{sys}\sc.exe'), 'delete ' + SERVICE_NAME, '', SW_HIDE, ewWaitUntilTerminated, rc);
  // sc delete only MARKS the service for deletion; the SCM keeps the record until every open handle
  // (services.msc, a monitoring agent) closes. Poll until it's truly gone so the re-install below
  // can't hit ERROR_SERVICE_MARKED_FOR_DELETE (1072) and silently fail. Once gone, node.exe is
  // unlocked → clean the Program Files payload for a true clean-install of the code (data untouched).
  for i := 1 to 30 do    // ~15s bounded
  begin
    if not ServiceExists() then begin CleanAppPayload(); exit; end;
    Sleep(500);
  end;
  Result := 'Windows is still removing the previous Triboon service (a Services or Task Manager window may be holding it open). Please close those windows and run the installer again.';
end;

// ProgramData grants BUILTIN\Users read on inherited content, and NTFS ignores the server's POSIX
// 0600 file mode, so secret.json (the token-signing key) would be readable by any local user. Break
// inheritance and grant Full only to SYSTEM (the LocalSystem service account) + Administrators.
procedure HardenDataDir();
var rc: Integer; dir: String;
begin
  dir := ExpandConstant('{commonappdata}\Triboon');
  // Pass 1 (ADDITIVE, inheritance still intact): guarantee SYSTEM (the service account) + Administrators
  // have an EXPLICIT Full ACE first. /inheritance:r removes only INHERITED aces, never explicit ones — so
  // doing this before the strip means a file that is momentarily locked during the recursive apply can
  // never be left with no usable ACE. That orphaning previously locked the service out of secret.json,
  // which surfaced as "Windows could not start the service — Error 1067".
  Exec(ExpandConstant('{sys}\icacls.exe'),
    '"' + dir + '" /grant "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C /Q',
    '', SW_HIDE, ewWaitUntilTerminated, rc);
  // Pass 2: now drop the inherited BUILTIN\Users read so secret.json is not world-readable, re-affirming
  // the SYSTEM + Administrators grants. Even if this fails on a locked file, Pass 1's explicit SYSTEM ACE
  // survives (inheritance:r keeps explicit aces), so the service always retains read access.
  Exec(ExpandConstant('{sys}\icacls.exe'),
    '"' + dir + '" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C /Q',
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

// The data-path bug (settings/users lost on every upgrade) is fixed IN THE SERVER: it now expands %VAR%
// in TRIBOON_DATA itself, so data always lands in the kept-on-upgrade ProgramData dir regardless of
// whether WinSW expanded the variable. This installer step RECOVERS data a previous (buggy) install
// wrote into the app folder, moving it to the correct dir — but only when the correct dir has NO files
// yet, so it never clobbers good data. Best-effort; if a prior uninstall already deleted the app folder
// there is nothing to move.
function DirHasFiles(dir: String): Boolean;
var fr: TFindRec;
begin
  Result := False;
  if FindFirst(dir + '\*', fr) then begin
    repeat
      if (fr.Name <> '.') and (fr.Name <> '..') then begin Result := True; Break; end;
    until not FindNext(fr);
    FindClose(fr);
  end;
end;

procedure MigrateStrayData();
var rc: Integer; stray, target: String;
begin
  target := ExpandConstant('{commonappdata}\Triboon\data');
  if DirHasFiles(target) then exit; // correct dir already has data — leave it
  stray := ExpandConstant('{app}') + '\%ProgramData%\Triboon\data'; // literal-%ProgramData% (unexpanded) location
  if not DirExists(stray) then stray := ExpandConstant('{app}\data'); // or the bare ./data default
  if not DirExists(stray) then exit;
  ForceDirectories(target);
  Exec(ExpandConstant('{sys}\robocopy.exe'), '"' + stray + '" "' + target + '" /E /R:1 /W:1 /NP /NFL /NDL /NJH /NJS', '', SW_HIDE, ewWaitUntilTerminated, rc);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var rc, i: Integer;
begin
  if CurStep <> ssPostInstall then exit;

  MigrateStrayData();       // recover data a prior buggy install left in the app folder
  WriteServiceDataPath();   // pin TRIBOON_DATA to the literal ProgramData path in the installed config
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

// Stop the per-user tray before the uninstaller removes {app}, so it can't hold a handle (and it
// doesn't linger pointing at a deleted service). The [UninstallRun] entries already stop/remove the
// service + firewall rule; this covers the tray, which runs as the logged-in user.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then StopTray();
end;
