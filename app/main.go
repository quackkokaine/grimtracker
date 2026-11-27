// GrimTracker desktop app.
//
// Runs the GrimTracker website from a small local web server (127.0.0.1 only) and shows it
// in its own window (Microsoft Edge or Chrome "app" mode). Because the app, not the browser,
// opens the files, it can read Grim Dawn saves wherever they are, including the Steam Cloud
// folder under Program Files that browsers refuse to open.
//
// Everything is read-only except the app's own data folder (%APPDATA%\GrimTracker), where
// the tracker's progress and the Hall of the Fallen are kept with daily backups.
package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	Version  = "1.0.0"
	Port     = 47819
	SiteURL  = "https://quackkokaine.github.io/grimtracker/"
	AppName  = "GrimTracker"
	idleQuit = 60 * time.Second // quit this long after the last window stops talking to us
)

//go:embed site
var embedded embed.FS

var (
	dataDir   string // %APPDATA%\GrimTracker
	siteDir   string // cached copy of the latest website
	cfg       Config
	cfgMu     sync.Mutex
	lastSeen  = time.Now()
	seenMu    sync.Mutex
	everSeen  bool
	stateMu   sync.Mutex
	logger    *log.Logger
	shutdownC = make(chan struct{}, 1)
)

type Config struct {
	SaveRoot string `json:"saveRoot,omitempty"` // "" = automatic, otherwise a root id
	GameDir  string `json:"gameDir,omitempty"`  // "" = detect
}

type Root struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Path   string `json:"path"`
	Count  int    `json:"count"`  // character files found
	Newest int64  `json:"newest"` // newest player.gdc, ms since epoch
}

func main() {
	var err error
	dataDir, err = appDataDir()
	if err != nil {
		fatal("Couldn't find a place to keep GrimTracker's data: " + err.Error())
	}
	os.MkdirAll(dataDir, 0o755)
	siteDir = filepath.Join(dataDir, "site")
	lf, _ := os.OpenFile(filepath.Join(dataDir, "grimtracker.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if lf != nil {
		logger = log.New(lf, "", log.LstdFlags)
	} else {
		logger = log.New(io.Discard, "", 0)
	}
	logger.Printf("GrimTracker %s starting, data in %s", Version, dataDir)
	loadConfig()

	args := os.Args[1:]
	noWindow := hasArg(args, "--no-window") // tests
	if !noWindow && !hasArg(args, "--no-install") {
		if done := maybeInstall(); done {
			return // the installed copy has been started
		}
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", Port))
	if err != nil {
		// already running: just open another window onto it
		logger.Printf("port busy, assuming GrimTracker is already running: %v", err)
		if !noWindow {
			openWindow(appURL(), false)
		}
		return
	}

	if !noWindow {
		refreshSite(4 * time.Second)
	} else if os.Getenv("GT_NO_UPDATE") == "" {
		refreshSite(4 * time.Second)
	}

	srv := &http.Server{Handler: guard(routes()), ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	logger.Printf("serving on %s", appURL())

	if !noWindow {
		go func() {
			if waited := openWindow(appURL(), true); waited {
				// our own browser window process ended: the user closed GrimTracker
				shutdown("window closed")
			}
		}()
	}
	go idleWatch()

	<-shutdownC
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

func shutdown(why string) {
	logger.Printf("shutting down: %s", why)
	select {
	case shutdownC <- struct{}{}:
	default:
	}
}

func idleWatch() {
	for range time.Tick(5 * time.Second) {
		seenMu.Lock()
		idle := time.Since(lastSeen)
		ever := everSeen
		seenMu.Unlock()
		if ever && idle > idleQuit {
			shutdown("no window open")
			return
		}
		if !ever && idle > 5*time.Minute {
			shutdown("window never connected")
			return
		}
	}
}

func appURL() string { return fmt.Sprintf("http://127.0.0.1:%d/", Port) }

func hasArg(args []string, a string) bool {
	for _, x := range args {
		if strings.EqualFold(x, a) {
			return true
		}
	}
	return false
}

/* ---------- config ---------- */

func loadConfig() {
	b, err := os.ReadFile(filepath.Join(dataDir, "config.json"))
	if err == nil {
		json.Unmarshal(b, &cfg)
	}
}

func saveConfig() error {
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return writeAtomic(filepath.Join(dataDir, "config.json"), b)
}

func writeAtomic(name string, b []byte) error {
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, name)
}

/* ---------- finding saves and the game ---------- */

func saveRoots() []Root {
	var roots []Root
	if docs := documentsDir(); docs != "" {
		p := filepath.Join(docs, "My Games", "Grim Dawn", "save")
		if isDir(p) {
			roots = append(roots, describeRoot("local", "Local saves (Documents)", p))
		}
	}
	for _, steam := range steamDirs() {
		ud := filepath.Join(steam, "userdata")
		ents, _ := os.ReadDir(ud)
		for _, e := range ents {
			p := filepath.Join(ud, e.Name(), "219990", "remote", "save")
			if e.IsDir() && isDir(p) {
				label := "Steam Cloud saves"
				roots = append(roots, describeRoot("steam:"+e.Name(), label+" (Steam account "+e.Name()+")", p))
			}
		}
	}
	// one Steam account is by far the common case: keep its label short
	nSteam := 0
	for _, r := range roots {
		if strings.HasPrefix(r.ID, "steam:") {
			nSteam++
		}
	}
	if nSteam == 1 {
		for i := range roots {
			if strings.HasPrefix(roots[i].ID, "steam:") {
				roots[i].Label = "Steam Cloud saves"
			}
		}
	}
	return roots
}

func describeRoot(id, label, p string) Root {
	r := Root{ID: id, Label: label, Path: p}
	walkSaves(p, 0, func(name string, info fs.FileInfo) {
		r.Count++
		if ms := info.ModTime().UnixMilli(); ms > r.Newest {
			r.Newest = ms
		}
	})
	return r
}

var skipDir = regexp.MustCompile(`(?i)\.map$|^levels_|^formulas|^settings`)

func walkSaves(dir string, depth int, fn func(string, fs.FileInfo)) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		full := filepath.Join(dir, e.Name())
		if e.IsDir() {
			if depth < 5 && !skipDir.MatchString(e.Name()) {
				walkSaves(full, depth+1, fn)
			}
		} else if strings.EqualFold(e.Name(), "player.gdc") {
			if info, err := e.Info(); err == nil {
				fn(full, info)
			}
		}
	}
}

// the save folder in use: the one picked in settings, otherwise whichever was played most recently
func activeRoot(roots []Root) *Root {
	cfgMu.Lock()
	want := cfg.SaveRoot
	cfgMu.Unlock()
	if want != "" {
		for i := range roots {
			if roots[i].ID == want {
				return &roots[i]
			}
		}
	}
	var best *Root
	for i := range roots {
		if roots[i].Count == 0 {
			continue
		}
		if best == nil || roots[i].Newest > best.Newest {
			best = &roots[i]
		}
	}
	if best == nil && len(roots) > 0 {
		best = &roots[0]
	}
	return best
}

func isGameDir(p string) bool {
	return p != "" && isDir(filepath.Join(p, "database")) && isFile(filepath.Join(p, "database", "database.arz"))
}

func gameDir() (string, bool) {
	cfgMu.Lock()
	want := cfg.GameDir
	cfgMu.Unlock()
	if want != "" {
		return want, isGameDir(want)
	}
	for _, p := range gameCandidates() {
		if isGameDir(p) {
			return p, true
		}
	}
	return "", false
}

func gameCandidates() []string {
	var out []string
	for _, steam := range steamDirs() {
		for _, lib := range steamLibraries(steam) {
			out = append(out, filepath.Join(lib, "steamapps", "common", "Grim Dawn"))
		}
	}
	out = append(out, otherGameDirs()...)
	return out
}

var vdfPath = regexp.MustCompile(`^\s*"path"\s+"(.+)"\s*$`)

func steamLibraries(steam string) []string {
	libs := []string{steam}
	f, err := os.Open(filepath.Join(steam, "steamapps", "libraryfolders.vdf"))
	if err != nil {
		return libs
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m := vdfPath.FindStringSubmatch(sc.Text()); m != nil {
			p := strings.ReplaceAll(m[1], `\\`, `\`)
			if !containsFold(libs, p) {
				libs = append(libs, p)
			}
		}
	}
	return libs
}

func containsFold(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(filepath.Clean(x), filepath.Clean(s)) {
			return true
		}
	}
	return false
}

func isDir(p string) bool  { st, err := os.Stat(p); return err == nil && st.IsDir() }
func isFile(p string) bool { st, err := os.Stat(p); return err == nil && !st.IsDir() }

/* ---------- HTTP ---------- */

// Only answers requests addressed to 127.0.0.1:Port (blocks DNS-rebinding tricks), and every
// /api call must carry the X-GT header, which other websites can't send without our consent.
func guard(h http.Handler) http.Handler {
	okHost := map[string]bool{fmt.Sprintf("127.0.0.1:%d", Port): true, fmt.Sprintf("localhost:%d", Port): true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !okHost[r.Host] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if r.Header.Get("X-GT") != "1" {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if o := r.Header.Get("Origin"); o != "" && !okHost[strings.TrimPrefix(strings.TrimPrefix(o, "http://"), "https://")] {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			seenMu.Lock()
			lastSeen = time.Now()
			everSeen = true
			seenMu.Unlock()
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		h.ServeHTTP(w, r)
	})
}

func routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/info", apiInfo)
	mux.HandleFunc("/api/config", apiConfig)
	mux.HandleFunc("/api/ls", apiLs)
	mux.HandleFunc("/api/read", apiRead)
	mux.HandleFunc("/api/state", apiState)
	mux.HandleFunc("/api/autostart", apiAutostart)
	mux.HandleFunc("/api/open", apiOpen)
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		w.Write([]byte("bye"))
		go func() { time.Sleep(200 * time.Millisecond); shutdown("asked to quit") }()
	})
	mux.HandleFunc("/", serveSite)
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func apiInfo(w http.ResponseWriter, r *http.Request) {
	roots := saveRoots()
	act := activeRoot(roots)
	gd, ok := gameDir()
	cfgMu.Lock()
	c := cfg
	cfgMu.Unlock()
	out := map[string]any{
		"app": true, "version": Version, "roots": roots, "saveRoot": c.SaveRoot,
		"game": map[string]any{"path": gd, "found": ok, "custom": c.GameDir != ""},
		"autostart": autostartEnabled(), "dataDir": dataDir, "siteFrom": siteSource,
	}
	if act != nil {
		out["active"] = act.ID
	}
	writeJSON(w, out)
}

func apiConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		SaveRoot *string `json:"saveRoot"`
		GameDir  *string `json:"gameDir"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	cfgMu.Lock()
	if in.SaveRoot != nil {
		cfg.SaveRoot = *in.SaveRoot
	}
	if in.GameDir != nil {
		p := strings.Trim(strings.TrimSpace(*in.GameDir), `"`)
		if p != "" {
			// accept the exe or a subfolder being pasted
			if strings.HasSuffix(strings.ToLower(p), ".exe") {
				p = filepath.Dir(p)
			}
			if !isGameDir(p) && isGameDir(filepath.Dir(p)) {
				p = filepath.Dir(p)
			}
			if !isGameDir(p) {
				cfgMu.Unlock()
				http.Error(w, "That folder doesn't look like a Grim Dawn install (no database\\database.arz inside).", http.StatusBadRequest)
				return
			}
		}
		cfg.GameDir = p
	}
	err := saveConfig()
	cfgMu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	apiInfo(w, r)
}

// resolve "saves" / "game" plus a relative path to a real path inside that folder
func resolve(root, rel string) (string, error) {
	var base string
	switch root {
	case "saves":
		roots := saveRoots()
		a := activeRoot(roots)
		if a == nil {
			return "", errors.New("no Grim Dawn save folder found")
		}
		base = a.Path
	case "game":
		gd, ok := gameDir()
		if !ok {
			return "", errors.New("Grim Dawn install not found")
		}
		base = gd
	default:
		return "", errors.New("unknown root")
	}
	rel = strings.ReplaceAll(rel, "\\", "/")
	clean := path.Clean("/" + rel)
	if strings.Contains(clean, "..") {
		return "", errors.New("bad path")
	}
	full := filepath.Join(base, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	if r, err := filepath.Rel(base, full); err != nil || strings.HasPrefix(r, "..") {
		return "", errors.New("bad path")
	}
	return full, nil
}

func apiLs(w http.ResponseWriter, r *http.Request) {
	full, err := resolve(r.URL.Query().Get("root"), r.URL.Query().Get("p"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	ents, err := os.ReadDir(full)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	type ent struct {
		Name  string `json:"name"`
		Dir   bool   `json:"dir"`
		Size  int64  `json:"size,omitempty"`
		Mtime int64  `json:"mtime,omitempty"`
	}
	out := []ent{}
	for _, e := range ents {
		x := ent{Name: e.Name(), Dir: e.IsDir()}
		if !x.Dir {
			if info, err := e.Info(); err == nil {
				x.Size, x.Mtime = info.Size(), info.ModTime().UnixMilli()
			}
		}
		out = append(out, x)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	writeJSON(w, out)
}

// files the website is allowed to read: character saves, item databases, English text
var readable = regexp.MustCompile(`(?i)(\.gdc|\.arz|(^|[\\/])text_en\.arc)$`)

func apiRead(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	full, err := resolve(q.Get("root"), q.Get("p"))
	if err != nil || !readable.MatchString(full) {
		http.Error(w, "not allowed", http.StatusForbidden)
		return
	}
	// read the whole file at once: a save the game is still writing then fails cleanly and is retried
	f, err := os.Open(full)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Mtime", fmt.Sprint(st.ModTime().UnixMilli()))
	w.Header().Set("Content-Length", fmt.Sprint(st.Size()))
	io.Copy(w, f)
}

// The tracker's data (progress, Hall of the Fallen) is kept as a file so clearing browser
// data can't touch it. One dated backup per day, the last 30 kept.
func apiState(w http.ResponseWriter, r *http.Request) {
	name := filepath.Join(dataDir, "tracker.json")
	stateMu.Lock()
	defer stateMu.Unlock()
	switch r.Method {
	case http.MethodGet:
		b, err := os.ReadFile(name)
		if err != nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	case http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		if err != nil || !json.Valid(b) || len(bytes.TrimSpace(b)) < 2 {
			http.Error(w, "bad data", http.StatusBadRequest)
			return
		}
		if err := writeAtomic(name, b); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		bdir := filepath.Join(dataDir, "backups")
		os.MkdirAll(bdir, 0o755)
		os.WriteFile(filepath.Join(bdir, "tracker-"+time.Now().Format("2006-01-02")+".json"), b, 0o644)
		pruneBackups(bdir, 30)
		w.Write([]byte("ok"))
	default:
		http.Error(w, "GET or POST", http.StatusMethodNotAllowed)
	}
}

func pruneBackups(dir string, keep int) {
	ents, _ := os.ReadDir(dir)
	var names []string
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "tracker-") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for len(names) > keep {
		os.Remove(filepath.Join(dir, names[0]))
		names = names[1:]
	}
}

func apiAutostart(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var in struct {
			On bool `json:"on"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&in); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if err := setAutostart(in.On); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	writeJSON(w, map[string]bool{"on": autostartEnabled()})
}

// open one of our known folders in Explorer
func apiOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var p string
	switch r.URL.Query().Get("what") {
	case "data":
		p = dataDir
	case "saves":
		if a := activeRoot(saveRoots()); a != nil {
			p = a.Path
		}
	case "game":
		p, _ = gameDir()
	}
	if p == "" || !isDir(p) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	openFolder(p)
	w.Write([]byte("ok"))
}

/* ---------- the website itself ---------- */

var siteSource = "built-in"

// serve the newest copy of the site we have: downloaded at startup, else the one built into the app
func serveSite(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" {
		p = "index.html"
	}
	if strings.Contains(p, "..") {
		http.NotFound(w, r)
		return
	}
	if ct := mime.TypeByExtension(path.Ext(p)); ct != "" {
		w.Header().Set("Content-Type", ct)
	} else if strings.HasSuffix(p, ".webp") {
		w.Header().Set("Content-Type", "image/webp")
	}
	if siteSource == "downloaded" {
		if b, err := os.ReadFile(filepath.Join(siteDir, filepath.FromSlash(p))); err == nil {
			w.Write(b)
			return
		}
	}
	b, err := embedded.ReadFile("site/" + p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Write(b)
}

var assetRef = regexp.MustCompile(`(?:src|href)=["'](assets/[^"'?#]+)`)

// Download the current website so the app always shows the latest version. Falls back to the
// last downloaded copy, then to the copy built into the app, when offline.
func refreshSite(timeout time.Duration) {
	if isFile(filepath.Join(siteDir, "index.html")) {
		siteSource = "downloaded"
	}
	cl := &http.Client{Timeout: timeout}
	get := func(rel string) ([]byte, error) {
		resp, err := cl.Get(SiteURL + rel + "?app=" + Version + "&t=" + fmt.Sprint(time.Now().Unix()))
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("%s: HTTP %d", rel, resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	}
	idx, err := get("index.html")
	if err != nil || !bytes.Contains(idx, []byte("GrimTracker")) {
		logger.Printf("site update skipped: %v", err)
		return
	}
	tmp := siteDir + ".new"
	os.RemoveAll(tmp)
	os.MkdirAll(filepath.Join(tmp, "assets"), 0o755)
	os.WriteFile(filepath.Join(tmp, "index.html"), idx, 0o644)
	seen := map[string]bool{}
	for _, m := range assetRef.FindAllSubmatch(idx, -1) {
		rel := string(m[1])
		if seen[rel] || strings.Contains(rel, "..") {
			continue
		}
		seen[rel] = true
		b, err := get(rel)
		if err != nil {
			logger.Printf("site update incomplete (%v), keeping the previous copy", err)
			os.RemoveAll(tmp)
			return
		}
		os.MkdirAll(filepath.Dir(filepath.Join(tmp, filepath.FromSlash(rel))), 0o755)
		os.WriteFile(filepath.Join(tmp, filepath.FromSlash(rel)), b, 0o644)
	}
	os.RemoveAll(siteDir + ".old")
	os.Rename(siteDir, siteDir+".old")
	if err := os.Rename(tmp, siteDir); err != nil {
		os.Rename(siteDir+".old", siteDir)
		logger.Printf("site update failed: %v", err)
		return
	}
	os.RemoveAll(siteDir + ".old")
	siteSource = "downloaded"
	logger.Printf("site updated (%d assets)", len(seen))
}

func fatal(msg string) {
	if logger != nil {
		logger.Print(msg)
	}
	messageBox(AppName, msg)
	os.Exit(1)
}
