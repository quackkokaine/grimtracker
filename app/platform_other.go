//go:build !windows

package main

// Stand-ins so the app can be built and tested on Linux. Folders come from environment
// variables: GT_DATA (app data), GT_DOCS (Documents), GT_STEAM (Steam folder), GT_GAME (game).

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

var autostartOn bool

func appDataDir() (string, error) {
	if d := os.Getenv("GT_DATA"); d != "" {
		return d, nil
	}
	d, err := os.UserConfigDir()
	return filepath.Join(d, AppName), err
}

func documentsDir() string { return os.Getenv("GT_DOCS") }

func steamDirs() []string {
	if d := os.Getenv("GT_STEAM"); d != "" {
		return []string{d}
	}
	return nil
}

func otherGameDirs() []string {
	if d := os.Getenv("GT_GAME"); d != "" {
		return []string{d}
	}
	return nil
}

func openWindow(url string, wait bool) bool { fmt.Println("open", url); return false }
func openFolder(p string)                   { fmt.Println("open folder", p) }
func messageBox(title, text string)         { fmt.Fprintln(os.Stderr, title+": "+text) }
func autostartEnabled() bool                { return autostartOn }
func setAutostart(on bool) error            { autostartOn = on; return nil }
func maybeInstall() bool                    { return false }

const exeMagic = "\x7fELF"

func canSelfUpdate() bool { return os.Getenv("GT_SELFUPDATE") != "" }

func startDetached(exe string, args ...string) error {
	c := exec.Command(exe, args...)
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	return c.Start()
}
