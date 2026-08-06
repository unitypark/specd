// Package config stores the CLI's credentials and defaults.
//
// The token is short-lived and project-scoped. On macOS it goes to the login
// keychain; elsewhere it lands in a 0600 file under the user's config dir.
// Either way it never sits in a shell profile or a dotfile the user might
// commit (§9).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	keychainService = "specd-cli"
	keychainAccount = "api-token"
	DefaultAPI      = "http://localhost:4000/api"
)

// Config is the non-secret part: which server, which project.
type Config struct {
	API     string `json:"api"`
	Project string `json:"project,omitempty"`
	// Learned from the server at login; `specd open` needs it because the web
	// app and the API are not the same origin.
	WebOrigin string `json:"webOrigin,omitempty"`
}

func dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(base, "specd")
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	return d, nil
}

func Load() (*Config, error) {
	cfg := &Config{API: DefaultAPI}

	d, err := dir()
	if err != nil {
		return cfg, nil // usable defaults beat a hard failure here
	}

	raw, err := os.ReadFile(filepath.Join(d, "config.json"))
	if err == nil {
		_ = json.Unmarshal(raw, cfg)
	}

	// Environment wins, so CI can point at a different server without a file.
	if v := os.Getenv("SPECD_API"); v != "" {
		cfg.API = v
	}
	if v := os.Getenv("SPECD_PROJECT"); v != "" {
		cfg.Project = v
	}
	if v := os.Getenv("SPECD_WEB"); v != "" {
		cfg.WebOrigin = v
	}
	if cfg.API == "" {
		cfg.API = DefaultAPI
	}
	return cfg, nil
}

func (c *Config) Save() error {
	d, err := dir()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(d, "config.json"), raw, 0o600)
}

// ─── token storage ───────────────────────────────────────────────────────────

func SaveToken(token string) error {
	if runtime.GOOS == "darwin" {
		if err := keychainSet(token); err == nil {
			return nil
		}
		// Keychain can be unavailable (headless CI, locked login keychain).
		// Fall through to the file rather than failing the login outright.
	}
	d, err := dir()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(d, "token"), []byte(token), 0o600)
}

func LoadToken() (string, error) {
	if v := os.Getenv("SPECD_TOKEN"); v != "" {
		return v, nil
	}
	if runtime.GOOS == "darwin" {
		if token, err := keychainGet(); err == nil && token != "" {
			return token, nil
		}
	}
	d, err := dir()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(d, "token"))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNotLoggedIn
		}
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

func ClearToken() error {
	if runtime.GOOS == "darwin" {
		_ = exec.Command("security", "delete-generic-password",
			"-s", keychainService, "-a", keychainAccount).Run()
	}
	d, err := dir()
	if err != nil {
		return err
	}
	err = os.Remove(filepath.Join(d, "token"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

var ErrNotLoggedIn = errors.New("not logged in — run `specd login`")

func keychainSet(token string) error {
	cmd := exec.Command("security", "add-generic-password",
		"-s", keychainService, "-a", keychainAccount, "-w", token, "-U")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("keychain: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func keychainGet() (string, error) {
	cmd := exec.Command("security", "find-generic-password",
		"-s", keychainService, "-a", keychainAccount, "-w")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
