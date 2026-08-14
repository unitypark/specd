// Package api is the CLI's thin wrapper over the specd HTTP API.
//
// Thin is the point (D13): this client fetches, registers and reports. There
// is deliberately no method here that authors, reviews or approves a spec —
// those live in the app, and the server refuses them for CLI tokens anyway.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	Token   string
	http    *http.Client
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// APIError carries the server's own message. The server explains refusals
// (an unapproved spec, a spend cap) far better than the CLI could guess.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("request failed with status %d", e.Status)
}

// NotApproved reports whether the failure was the gate refusing a draft.
func (e *APIError) NotApproved() bool { return e.Code == "spec_not_approved" }

func (c *Client) do(method, path string, body any, accept string) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s: %w", c.BaseURL, err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}

	if res.StatusCode >= 400 {
		apiErr := &APIError{Status: res.StatusCode}
		var payload struct {
			Error   string          `json:"error"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(raw, &payload) == nil {
			apiErr.Code = payload.Error
			var msg string
			if json.Unmarshal(payload.Message, &msg) == nil {
				apiErr.Message = msg
			} else {
				var msgs []string
				if json.Unmarshal(payload.Message, &msgs) == nil {
					apiErr.Message = strings.Join(msgs, "; ")
				}
			}
		}
		if apiErr.Message == "" {
			apiErr.Message = strings.TrimSpace(string(raw))
		}
		return nil, apiErr
	}

	return raw, nil
}

func (c *Client) getJSON(path string, out any) error {
	raw, err := c.do(http.MethodGet, path, nil, "application/json")
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// ─── device-code login ───────────────────────────────────────────────────────

type DeviceStart struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURI string `json:"verificationUri"`
	ExpiresIn       int    `json:"expiresIn"`
	Interval        int    `json:"interval"`
}

func (c *Client) StartDeviceFlow() (*DeviceStart, error) {
	raw, err := c.do(http.MethodPost, "/auth/device/start", struct{}{}, "application/json")
	if err != nil {
		return nil, err
	}
	out := &DeviceStart{}
	return out, json.Unmarshal(raw, out)
}

// PollDeviceFlow returns "" while the human has not confirmed in the browser yet.
func (c *Client) PollDeviceFlow(deviceCode string) (string, error) {
	raw, err := c.do(http.MethodPost, "/auth/device/poll",
		map[string]string{"deviceCode": deviceCode}, "application/json")
	if err != nil {
		return "", err
	}
	var out struct {
		Token   string `json:"token"`
		Pending bool   `json:"pending"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	return out.Token, nil
}

type Me struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	Audience string `json:"audience"`
	// Where the web app lives. The CLI cannot derive this from the API URL —
	// they are different origins — so the server reports it.
	WebOrigin string `json:"webOrigin"`
}

func (c *Client) Me() (*Me, error) {
	out := &Me{}
	return out, c.getJSON("/auth/me", out)
}

// ─── projects & specs ────────────────────────────────────────────────────────

type Project struct {
	Slug            string `json:"slug"`
	Name            string `json:"name"`
	RepoCount       int    `json:"repoCount"`
	SpecsInReview   int    `json:"specsInReview"`
	KnowledgeHealth int    `json:"knowledgeHealth"`
}

func (c *Client) Projects() ([]Project, error) {
	var out []Project
	return out, c.getJSON("/cli/projects", &out)
}

type SpecSummary struct {
	Key        string `json:"key"`
	Title      string `json:"title"`
	SpecID     string `json:"specId"`
	Version    int    `json:"version"`
	Status     string `json:"status"`
	ApprovedBy string `json:"approvedBy"`
	Citations  int    `json:"citations"`
	Unverified int    `json:"unverified"`
}

func (c *Client) Specs(project, status string) ([]SpecSummary, error) {
	path := fmt.Sprintf("/cli/projects/%s/specs", url.PathEscape(project))
	if status != "" {
		path += "?status=" + url.QueryEscape(status)
	}
	var out []SpecSummary
	return out, c.getJSON(path, &out)
}

type SpecStatus struct {
	ID         string `json:"id"`
	TicketKey  string `json:"ticketKey"`
	Title      string `json:"title"`
	Version    int    `json:"version"`
	Status     string `json:"status"`
	ApprovedBy string `json:"approvedBy"`
	ApprovedAt string `json:"approvedAt"`
	Buildable  bool   `json:"buildable"`
}

func (c *Client) SpecStatus(project, ref string) (*SpecStatus, error) {
	path := fmt.Sprintf("/cli/projects/%s/specs/%s/status",
		url.PathEscape(project), url.PathEscape(ref))
	out := &SpecStatus{}
	return out, c.getJSON(path, out)
}

// SpecPull fetches the approved spec as markdown. The server refuses anything
// that has not been stamped — this client cannot ask it not to.
func (c *Client) SpecPull(project, ref string) (string, error) {
	path := fmt.Sprintf("/cli/projects/%s/specs/%s/pull",
		url.PathEscape(project), url.PathEscape(ref))
	raw, err := c.do(http.MethodGet, path, nil, "text/markdown")
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

type ConnectResult struct {
	OK         bool   `json:"ok"`
	Reason     string `json:"reason"`
	Clean      bool   `json:"clean"`
	Repository struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		IsPrimary bool   `json:"isPrimary"`
	} `json:"repository"`
}

// ─── runner pairing ──────────────────────────────────────────────────────────
//
// A runner is a machine, not a user — it presents a short pairing code shown
// once in the wizard, the same shape `specd login`'s device flow uses for a
// different audience, and gets back a long-lived bearer token in return.

type RunnerPairResult struct {
	Token    string `json:"token"`
	RunnerID string `json:"runnerId"`
	Project  string `json:"project"`
}

func (c *Client) PairRunner(pairCode string) (*RunnerPairResult, error) {
	raw, err := c.do(http.MethodPost, "/runners/pair",
		map[string]string{"pairCode": pairCode}, "application/json")
	if err != nil {
		return nil, err
	}
	out := &RunnerPairResult{}
	return out, json.Unmarshal(raw, out)
}

// RunnerHeartbeat proves the paired token is valid and that this machine can
// reach the API outbound — the two things `specd runner pair` promises to
// verify.
func (c *Client) RunnerHeartbeat() error {
	_, err := c.do(http.MethodPost, "/runners/heartbeat", struct{}{}, "application/json")
	return err
}

func (c *Client) Connect(project, path, name string, primary bool) (*ConnectResult, error) {
	primaryStr := "false"
	if primary {
		primaryStr = "true"
	}
	raw, err := c.do(http.MethodPost,
		fmt.Sprintf("/cli/projects/%s/connect", url.PathEscape(project)),
		map[string]string{"path": path, "name": name, "primary": primaryStr},
		"application/json")
	if err != nil {
		return nil, err
	}
	out := &ConnectResult{}
	return out, json.Unmarshal(raw, out)
}

// ─── knowledge ───────────────────────────────────────────────────────────────

// Chunk is a retrieved passage with the provenance the engine attached to it.
// CiteAs is the string a design claim would carry; it comes from the server so
// that a citation assembled here can never disagree with the one the validator
// checks.
type Chunk struct {
	CiteAs   string  `json:"citeAs"`
	RepoName string  `json:"repoName"`
	Path     string  `json:"path"`
	Heading  string  `json:"heading"`
	Text     string  `json:"text"`
	Score    float64 `json:"score"`
	Via      string  `json:"via"`
	ViaEdge  string  `json:"viaEdge"`
}

type SearchResult struct {
	Chunks       []Chunk `json:"chunks"`
	MatchedCount int     `json:"matchedCount"`
	// How many matching chunks were cut for budget. Reported, never hidden: a
	// cut that reads as an absence is how an agent concludes the knowledge
	// base has nothing to say.
	TruncatedCount int `json:"truncatedCount"`
}

func (c *Client) SearchKnowledge(project, query string, limit int) (*SearchResult, error) {
	path := fmt.Sprintf("/cli/projects/%s/knowledge/search?q=%s",
		url.PathEscape(project), url.QueryEscape(query))
	if limit > 0 {
		path += fmt.Sprintf("&limit=%d", limit)
	}
	out := &SearchResult{}
	return out, c.getJSON(path, out)
}

type DocLink struct {
	Kind       string `json:"kind"`
	RawTarget  string `json:"rawTarget"`
	State      string `json:"state"`
	TargetPath string `json:"targetPath"`
	SourcePath string `json:"sourcePath"`
}

type KnowledgeDoc struct {
	Path          string    `json:"path"`
	Kind          string    `json:"kind"`
	Title         string    `json:"title"`
	Content       string    `json:"content"`
	HasUnverified bool      `json:"hasUnverified"`
	IsStub        bool      `json:"isStub"`
	DocUpdatedAt  string    `json:"docUpdatedAt"`
	Outbound      []DocLink `json:"outbound"`
	Backlinks     []DocLink `json:"backlinks"`
}

func (c *Client) KnowledgeDoc(project, docPath string) (*KnowledgeDoc, error) {
	path := fmt.Sprintf("/cli/projects/%s/knowledge/doc?path=%s",
		url.PathEscape(project), url.QueryEscape(docPath))
	out := &KnowledgeDoc{}
	return out, c.getJSON(path, out)
}

// CitationCheck is the four-verdict answer: supported, stale, unsupported or
// unknown. Note is the sentence explaining which gap to close when the verdict
// is anything but supported.
type CitationCheck struct {
	Citation       string   `json:"citation"`
	Verdict        string   `json:"verdict"`
	Note           string   `json:"note"`
	CheckedAgainst []string `json:"checkedAgainst"`
}

func (c *Client) VerifyCitation(project, citation string) (*CitationCheck, error) {
	path := fmt.Sprintf("/cli/projects/%s/knowledge/verify?citation=%s",
		url.PathEscape(project), url.QueryEscape(citation))
	out := &CitationCheck{}
	return out, c.getJSON(path, out)
}

type KnowledgeHealth struct {
	Score                 float64 `json:"score"`
	DocCount              int     `json:"docCount"`
	StaleCount            int     `json:"staleCount"`
	StubCount             int     `json:"stubCount"`
	AsBuiltCount          int     `json:"asBuiltCount"`
	BrokenLinks           int     `json:"brokenLinks"`
	DanglingAnchors       int     `json:"danglingAnchors"`
	OrphanDocs            int     `json:"orphanDocs"`
	UnknownFreshnessCount int     `json:"unknownFreshnessCount"`
	Notes                 []struct {
		Icon string `json:"icon"`
		Text string `json:"text"`
	} `json:"notes"`
}

func (c *Client) KnowledgeHealth(project string) (*KnowledgeHealth, error) {
	path := fmt.Sprintf("/cli/projects/%s/knowledge/health", url.PathEscape(project))
	out := &KnowledgeHealth{}
	return out, c.getJSON(path, out)
}
