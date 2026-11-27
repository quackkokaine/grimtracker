//go:build windows

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	shell32                  = syscall.NewLazyDLL("shell32.dll")
	ole32                    = syscall.NewLazyDLL("ole32.dll")
	user32                   = syscall.NewLazyDLL("user32.dll")
	advapi32                 = syscall.NewLazyDLL("advapi32.dll")
	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
	procMessageBoxW          = user32.NewProc("MessageBoxW")
	procRegCreateKeyExW      = advapi32.NewProc("RegCreateKeyExW")
	procRegSetValueExW       = advapi32.NewProc("RegSetValueExW")
	procRegDeleteValueW      = advapi32.NewProc("RegDeleteValueW")
	procRegDeleteKeyW        = advapi32.NewProc("RegDeleteKeyW")
)

const (
	keyWow64_32  = 0x0200
	keyWow64_64  = 0x0100
	createNoWin  = 0x08000000
	mbYesNo      = 0x00000004
	mbIconInfo   = 0x00000040
	mbIconWarn   = 0x00000030
	mbIconQuest  = 0x00000020
	idYes        = 6
	runKey       = `Software\Microsoft\Windows\CurrentVersion\Run`
	uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\GrimTracker`
	runValueName = "GrimTracker"
)

type guid struct {
	Data1        uint32
	Data2, Data3 uint16
	Data4        [8]byte
}

var (
	folderDocuments = guid{0xFDD39AD0, 0x238F, 0x46AF, [8]byte{0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7}}
	folderDesktop   = guid{0xB4BFCC3A, 0xDB2C, 0x424C, [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41}}
)

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	n := 0
	for ptr := unsafe.Pointer(p); *(*uint16)(ptr) != 0; n++ {
		ptr = unsafe.Pointer(uintptr(ptr) + 2)
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

func knownFolder(id *guid) string {
	var p *uint16
	r, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(id)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if r != 0 || p == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return utf16PtrToString(p)
}

func appDataDir() (string, error) {
	d, err := os.UserConfigDir() // %APPDATA%
	if err != nil {
		return "", err
	}
	return filepath.Join(d, AppName), nil
}

func documentsDir() string {
	if d := knownFolder(&folderDocuments); d != "" {
		return d // follows OneDrive / moved Documents folders
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Documents")
}

func regString(root syscall.Handle, key, name string, extra uint32) string {
	var h syscall.Handle
	if syscall.RegOpenKeyEx(root, syscall.StringToUTF16Ptr(key), 0, syscall.KEY_READ|extra, &h) != nil {
		return ""
	}
	defer syscall.RegCloseKey(h)
	var typ, n uint32
	nm := syscall.StringToUTF16Ptr(name)
	if syscall.RegQueryValueEx(h, nm, nil, &typ, nil, &n) != nil || n == 0 {
		return ""
	}
	buf := make([]uint16, n/2+1)
	if syscall.RegQueryValueEx(h, nm, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n) != nil {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

func steamDirs() []string {
	var out []string
	add := func(p string) {
		p = filepath.Clean(strings.ReplaceAll(p, "/", `\`))
		if p != "." && isDir(p) && !containsFold(out, p) {
			out = append(out, p)
		}
	}
	add(regString(syscall.HKEY_CURRENT_USER, `Software\Valve\Steam`, "SteamPath", 0))
	add(regString(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Valve\Steam`, "InstallPath", keyWow64_32))
	add(regString(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\Valve\Steam`, "InstallPath", keyWow64_64))
	add(filepath.Join(os.Getenv("ProgramFiles(x86)"), "Steam"))
	add(filepath.Join(os.Getenv("ProgramFiles"), "Steam"))
	return out
}

func otherGameDirs() []string {
	var out []string
	for _, ex := range []uint32{keyWow64_32, keyWow64_64} {
		if p := regString(syscall.HKEY_LOCAL_MACHINE, `SOFTWARE\GOG.com\Games\1449651388`, "path", ex); p != "" {
			out = append(out, p)
		}
	}
	return append(out, `C:\GOG Games\Grim Dawn`, filepath.Join(os.Getenv("ProgramFiles(x86)"), "GOG Galaxy", "Games", "Grim Dawn"))
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWin}
	return cmd
}

func browserPath() string {
	pf, pf86, lad := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")
	for _, p := range []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(lad, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(lad, `Google\Chrome\Application\chrome.exe`),
	} {
		if isFile(p) {
			return p
		}
	}
	return ""
}

// Opens GrimTracker in its own window: Edge (or Chrome) in app mode with a separate profile,
// so the user's own browsing data and cookie clean-ups never touch it. When wait is true and
// the window was ours, returns true once it's closed.
func openWindow(url string, wait bool) bool {
	b := browserPath()
	if b == "" {
		hidden(exec.Command("rundll32", "url.dll,FileProtocolHandler", url)).Start()
		return false
	}
	prof := filepath.Join(dataDir, "window")
	if !isDir(prof) {
		os.MkdirAll(prof, 0o755)
		// don't let the browser keep running in the background after the window is closed
		st, _ := json.Marshal(map[string]any{"background_mode": map[string]bool{"enabled": false}})
		os.WriteFile(filepath.Join(prof, "Local State"), st, 0o644)
	}
	cmd := exec.Command(b, "--app="+url, "--user-data-dir="+prof, "--window-size=1440,920",
		"--no-first-run", "--no-default-browser-check", "--disable-features=msEdgeStartupBoost,msImplicitSignin")
	start := time.Now()
	if err := cmd.Start(); err != nil {
		logger.Printf("couldn't start %s: %v", b, err)
		hidden(exec.Command("rundll32", "url.dll,FileProtocolHandler", url)).Start()
		return false
	}
	if !wait {
		return false
	}
	cmd.Wait()
	// a very quick exit means the window was handed to an already-running copy: not closed
	return time.Since(start) > 4*time.Second
}

func openFolder(p string) { exec.Command("explorer.exe", p).Start() }

func messageBox(title, text string) { msgBox(title, text, mbIconWarn) }

func msgBox(title, text string, flags uintptr) int {
	r, _, _ := procMessageBoxW.Call(0, uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(text))),
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(title))), flags)
	return int(r)
}

/* ---------- registry writes (current user only) ---------- */

func regSetString(key, name, val string) error {
	var h syscall.Handle
	var disp uint32
	r, _, _ := procRegCreateKeyExW.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(key))),
		0, 0, 0, uintptr(syscall.KEY_WRITE), 0, uintptr(unsafe.Pointer(&h)), uintptr(unsafe.Pointer(&disp)))
	if r != 0 {
		return syscall.Errno(r)
	}
	defer syscall.RegCloseKey(h)
	v, _ := syscall.UTF16FromString(val)
	r, _, _ = procRegSetValueExW.Call(uintptr(h), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(name))), 0, uintptr(syscall.REG_SZ),
		uintptr(unsafe.Pointer(&v[0])), uintptr(len(v)*2))
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

func regSetDword(key, name string, val uint32) error {
	var h syscall.Handle
	var disp uint32
	r, _, _ := procRegCreateKeyExW.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(key))),
		0, 0, 0, uintptr(syscall.KEY_WRITE), 0, uintptr(unsafe.Pointer(&h)), uintptr(unsafe.Pointer(&disp)))
	if r != 0 {
		return syscall.Errno(r)
	}
	defer syscall.RegCloseKey(h)
	r, _, _ = procRegSetValueExW.Call(uintptr(h), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(name))), 0, uintptr(syscall.REG_DWORD),
		uintptr(unsafe.Pointer(&val)), 4)
	if r != 0 {
		return syscall.Errno(r)
	}
	return nil
}

func regDeleteValue(key, name string) {
	var h syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, syscall.StringToUTF16Ptr(key), 0, syscall.KEY_WRITE, &h) != nil {
		return
	}
	defer syscall.RegCloseKey(h)
	procRegDeleteValueW.Call(uintptr(h), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(name))))
}

func installedExe() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", AppName, AppName+".exe")
}

func autostartEnabled() bool {
	return regString(syscall.HKEY_CURRENT_USER, runKey, runValueName, 0) != ""
}

func setAutostart(on bool) error {
	if !on {
		regDeleteValue(runKey, runValueName)
		return nil
	}
	exe := installedExe()
	if !isFile(exe) {
		exe, _ = os.Executable()
	}
	return regSetString(runKey, runValueName, `"`+exe+`"`)
}

/* ---------- install / update / uninstall ---------- */

// The downloaded exe installs itself for the current user (no admin): it copies itself to
// %LOCALAPPDATA%\Programs\GrimTracker, adds Start menu and desktop shortcuts and an entry in
// Settings > Apps, then starts the installed copy. Running a newer download updates it.
func maybeInstall() bool {
	if hasArg(os.Args[1:], "--uninstall") {
		uninstall()
		return true
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	inst := installedExe()
	if strings.EqualFold(filepath.Clean(exe), filepath.Clean(inst)) {
		return false
	}
	// Already installed and this download isn't newer: just open the installed app
	if have := regString(syscall.HKEY_CURRENT_USER, uninstallKey, "DisplayVersion", 0); isFile(inst) && have != "" && !newer(Version, have) {
		if err := exec.Command(inst).Start(); err == nil {
			return true
		}
	}
	quitRunningCopy()
	os.MkdirAll(filepath.Dir(inst), 0o755)
	var cerr error
	for i := 0; i < 10; i++ {
		if cerr = copyFile(exe, inst); cerr == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if cerr != nil {
		logger.Printf("install failed: %v", cerr)
		msgBox(AppName, "GrimTracker couldn't install itself ("+cerr.Error()+"). It will run from where it is this time.", mbIconWarn)
		return false
	}
	makeShortcuts(inst)
	regSetString(uninstallKey, "DisplayName", AppName)
	regSetString(uninstallKey, "DisplayVersion", Version)
	regSetString(uninstallKey, "Publisher", "GrimTracker")
	regSetString(uninstallKey, "DisplayIcon", inst+",0")
	regSetString(uninstallKey, "InstallLocation", filepath.Dir(inst))
	regSetString(uninstallKey, "UninstallString", `"`+inst+`" --uninstall`)
	regSetString(uninstallKey, "URLInfoAbout", SiteURL)
	regSetDword(uninstallKey, "NoModify", 1)
	regSetDword(uninstallKey, "NoRepair", 1)
	if autostartEnabled() {
		setAutostart(true) // point it at the installed copy
	}
	logger.Printf("installed %s to %s", Version, inst)
	if err := exec.Command(inst).Start(); err != nil {
		return false
	}
	return true
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	out.Close()
	os.Remove(dst + ".old")
	if isFile(dst) {
		if err := os.Rename(dst, dst+".old"); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Rename(dst+".old", dst)
		return err
	}
	os.Remove(dst + ".old")
	return nil
}

// ask an already-running GrimTracker to close so its file can be replaced
func quitRunningCopy() {
	req, _ := http.NewRequest("POST", appURL()+"api/quit", nil)
	req.Header.Set("X-GT", "1")
	cl := &http.Client{Timeout: 2 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
	for i := 0; i < 20; i++ {
		time.Sleep(250 * time.Millisecond)
		if _, err := cl.Get(appURL()); err != nil {
			return
		}
	}
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func shortcutPaths() []string {
	var out []string
	if ad := os.Getenv("APPDATA"); ad != "" {
		out = append(out, filepath.Join(ad, `Microsoft\Windows\Start Menu\Programs`, AppName+".lnk"))
	}
	if d := knownFolder(&folderDesktop); d != "" {
		out = append(out, filepath.Join(d, AppName+".lnk"))
	}
	return out
}

func makeShortcuts(target string) {
	var sb strings.Builder
	sb.WriteString("$s=New-Object -ComObject WScript.Shell;")
	for _, p := range shortcutPaths()[:1] { // Start menu only: no desktop shortcut
		sb.WriteString("$l=$s.CreateShortcut(" + psQuote(p) + ");$l.TargetPath=" + psQuote(target) +
			";$l.WorkingDirectory=" + psQuote(filepath.Dir(target)) + ";$l.IconLocation=" + psQuote(target+",0") +
			";$l.Description='Grim Dawn character and shrine tracker';$l.Save();")
	}
	if err := hidden(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", sb.String())).Run(); err != nil {
		logger.Printf("shortcuts: %v", err)
	}
}

func uninstall() {
	if msgBox(AppName, "Remove GrimTracker from this PC?\n\nYour Grim Dawn saves are never touched.", mbYesNo|mbIconQuest) != idYes {
		return
	}
	keepData := msgBox(AppName, "Also delete GrimTracker's own data (your tracker progress and Hall of the Fallen, plus their backups)?\n\nChoose No to keep it for later.", mbYesNo|mbIconWarn) != idYes
	quitRunningCopy()
	for _, p := range shortcutPaths() {
		os.Remove(p)
	}
	regDeleteValue(runKey, runValueName)
	procRegDeleteKeyW.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(uninstallKey))))
	dirs := `"` + filepath.Dir(installedExe()) + `"`
	if !keepData {
		dirs += ` "` + dataDir + `"`
	}
	// the running exe can't delete itself: let cmd finish the job a moment after we exit
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWin,
		CmdLine: `cmd.exe /s /c "ping -n 3 127.0.0.1 >nul & rmdir /s /q ` + dirs + `"`}
	cmd.Start()
	msgBox(AppName, "GrimTracker has been removed.", mbIconInfo)
}

const exeMagic = "MZ"

// only the installed copy updates itself
func canSelfUpdate() bool {
	exe, err := os.Executable()
	return err == nil && strings.EqualFold(filepath.Clean(exe), filepath.Clean(installedExe()))
}

func startDetached(exe string, args ...string) error { return exec.Command(exe, args...).Start() }
