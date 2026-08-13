package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/specd-dev/specd/cli/internal/api"
)

func newTestServer(t *testing.T, handler http.HandlerFunc) (*mcpServer, *strings.Builder) {
	t.Helper()
	out := &strings.Builder{}
	base := ""
	if handler != nil {
		srv := httptest.NewServer(handler)
		t.Cleanup(srv.Close)
		base = srv.URL
	}
	return &mcpServer{
		client:  api.New(base, "test-token"),
		project: "aurora",
		out:     json.NewEncoder(out),
	}, out
}

func request(t *testing.T, method string, params any) rpcRequest {
	t.Helper()
	req := rpcRequest{JSONRPC: "2.0", ID: json.RawMessage(`1`), Method: method}
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			t.Fatalf("marshal params: %v", err)
		}
		req.Params = raw
	}
	return req
}

// The handshake is the whole session: a client that cannot read this reply
// disconnects before any tool is ever offered.
func TestInitializeAnnouncesToolsAndResources(t *testing.T) {
	s, _ := newTestServer(t, nil)
	res := s.handle(request(t, "initialize", nil))
	if res == nil || res.Error != nil {
		t.Fatalf("initialize failed: %+v", res)
	}
	result, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("result = %T, want map", res.Result)
	}
	if result["protocolVersion"] != mcpProtocolVersion {
		t.Fatalf("protocolVersion = %v, want %s", result["protocolVersion"], mcpProtocolVersion)
	}
	caps, ok := result["capabilities"].(map[string]any)
	if !ok {
		t.Fatal("no capabilities in initialize reply")
	}
	if _, ok := caps["tools"]; !ok {
		t.Error("did not advertise tools")
	}
	if _, ok := caps["resources"]; !ok {
		t.Error("did not advertise resources")
	}
}

// A notification carries no id and must draw no reply. Answering one is a
// protocol violation that some clients hang up over — and `notifications/
// initialized` arrives in every single session, so getting this wrong breaks
// every session rather than an unlucky one.
func TestNotificationsGetNoReply(t *testing.T) {
	s, _ := newTestServer(t, nil)
	for _, id := range []json.RawMessage{nil, json.RawMessage(`null`)} {
		req := rpcRequest{JSONRPC: "2.0", ID: id, Method: "notifications/initialized"}
		if res := s.handle(req); res != nil {
			t.Fatalf("notification with id %q drew a reply: %+v", string(id), res)
		}
	}
}

func TestUnknownMethodIsAProtocolError(t *testing.T) {
	s, _ := newTestServer(t, nil)
	res := s.handle(request(t, "tools/teleport", nil))
	if res == nil || res.Error == nil {
		t.Fatalf("want an error reply, got %+v", res)
	}
	if res.Error.Code != rpcMethodNotFound {
		t.Fatalf("code = %d, want %d", res.Error.Code, rpcMethodNotFound)
	}
}

func TestToolsListOffersEveryToolWithASchema(t *testing.T) {
	s, _ := newTestServer(t, nil)
	res := s.handle(request(t, "tools/list", nil))
	tools, ok := res.Result.(map[string]any)["tools"].([]map[string]any)
	if !ok {
		t.Fatalf("tools = %T, want a list", res.Result.(map[string]any)["tools"])
	}
	if len(tools) != len(mcpTools) {
		t.Fatalf("offered %d tools, registry has %d", len(tools), len(mcpTools))
	}
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		if name == "" {
			t.Fatal("a tool went out with no name")
		}
		// A tool with no schema is a tool the model calls with invented
		// arguments; a tool with no description is one it never calls at all.
		if _, ok := tool["inputSchema"].(map[string]any); !ok {
			t.Errorf("%s has no inputSchema", name)
		}
		if desc, _ := tool["description"].(string); len(desc) < 30 {
			t.Errorf("%s has no usable description", name)
		}
	}
}

// The registry is the only place a tool is declared, so its invariants are
// worth asserting directly — a duplicate name silently shadows a tool, and a
// required argument that is not in `properties` is a schema no client can satisfy.
func TestToolRegistryIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, tool := range mcpTools {
		if seen[tool.name] {
			t.Fatalf("duplicate tool name %q", tool.name)
		}
		seen[tool.name] = true
		if tool.run == nil {
			t.Fatalf("%s has no implementation", tool.name)
		}
		props, ok := tool.schema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s has no properties in its schema", tool.name)
		}
		required, ok := tool.schema["required"].([]string)
		if !ok {
			t.Fatalf("%s has no required list", tool.name)
		}
		for _, key := range required {
			if _, declared := props[key]; !declared {
				t.Errorf("%s requires %q but never declares it", tool.name, key)
			}
		}
	}
}

func TestResourceRegistryIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range mcpResources {
		if seen[r.uri] {
			t.Fatalf("duplicate resource uri %q", r.uri)
		}
		seen[r.uri] = true
		if !strings.HasPrefix(r.uri, "specd://") {
			t.Errorf("%s is not a specd:// uri", r.uri)
		}
		if r.read == nil {
			t.Fatalf("%s has no reader", r.uri)
		}
	}
}

func TestCallingAnUnknownToolIsRefusedNotCrashed(t *testing.T) {
	s, _ := newTestServer(t, nil)
	res := s.handle(request(t, "tools/call", map[string]any{"name": "rm_rf", "arguments": map[string]any{}}))
	if res == nil || res.Error == nil {
		t.Fatalf("want an error reply, got %+v", res)
	}
	if res.Error.Code != rpcInvalidParams {
		t.Fatalf("code = %d, want %d", res.Error.Code, rpcInvalidParams)
	}
}

// A tool that fails must come back as a *result* flagged isError, never as a
// JSON-RPC error. The distinction is what lets an agent read the reason and
// act on it, instead of a client concluding the server is broken.
func TestAToolFailureIsAResultTheAgentCanRead(t *testing.T) {
	s, _ := newTestServer(t, nil)
	res := s.handle(request(t, "tools/call", map[string]any{
		"name": "search_knowledge", "arguments": map[string]any{},
	}))
	if res == nil || res.Error != nil {
		t.Fatalf("want a result, got error %+v", res)
	}
	result := res.Result.(map[string]any)
	if result["isError"] != true {
		t.Fatalf("isError = %v, want true", result["isError"])
	}
	content := result["content"].([]map[string]any)
	if !strings.Contains(content[0]["text"].(string), "query is required") {
		t.Fatalf("unhelpful failure text: %v", content[0]["text"])
	}
}

// The gate, seen from an editor. `spec pull` on an unapproved spec is a 409
// the server explains well; the agent needs to read that explanation and stop,
// so it must arrive as content rather than as a transport failure.
func TestPullingAnUnapprovedSpecExplainsRatherThanErrors(t *testing.T) {
	s, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"spec_not_approved","message":"This spec is \"draft\". Only approved specs can be pulled."}`))
	})
	res := s.handle(request(t, "tools/call", map[string]any{
		"name": "spec_pull", "arguments": map[string]any{"id": "CRM-1"},
	}))
	if res == nil || res.Error != nil {
		t.Fatalf("want a result, got %+v", res)
	}
	result := res.Result.(map[string]any)
	if result["isError"] == true {
		t.Fatal("the gate refusing a draft is the product working, not a tool failure")
	}
	text := result["content"].([]map[string]any)[0]["text"].(string)
	for _, want := range []string{"not approved", "Only approved specs can be pulled"} {
		if !strings.Contains(text, want) {
			t.Errorf("reply does not mention %q:\n%s", want, text)
		}
	}
}

func TestSearchReportsProvenanceAndTruncation(t *testing.T) {
	s, _ := newTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("q"); got != "how does a runner claim a job" {
			t.Errorf("query = %q", got)
		}
		_, _ = w.Write([]byte(`{"chunks":[
			{"citeAs":"knowledge/decisions/0004.md#dispatch","repoName":"specd","path":"knowledge/decisions/0004.md","text":"A runner polls.","score":0.9,"via":"vector"},
			{"citeAs":"apps/api/src/runner-jobs.service.ts#RunnerJobsService.claim","repoName":"specd","path":"apps/api/src/runner-jobs.service.ts","text":"claim() {}","score":0.4,"via":"code"},
			{"citeAs":"knowledge/architecture.md#runners","repoName":"specd","path":"knowledge/architecture.md","text":"Runners are paired.","score":0.3,"via":"graph","viaEdge":"citation from knowledge/decisions/0004.md#dispatch"}
		],"matchedCount":9,"truncatedCount":6}`))
	})
	res := s.handle(request(t, "tools/call", map[string]any{
		"name":      "search_knowledge",
		"arguments": map[string]any{"query": "how does a runner claim a job"},
	}))
	text := res.Result.(map[string]any)["content"].([]map[string]any)[0]["text"].(string)

	// The CITE-AS string has to survive verbatim: an agent that reformats it
	// produces a citation the validator then judges unsupported.
	if !strings.Contains(text, "CITE-AS: knowledge/decisions/0004.md#dispatch") {
		t.Errorf("no citable reference in:\n%s", text)
	}
	if !strings.Contains(text, "reached via citation from knowledge/decisions/0004.md#dispatch") {
		t.Errorf("graph expansion lost its provenance:\n%s", text)
	}
	if !strings.Contains(text, "source code a doc references") {
		t.Errorf("code chunk not labelled as code:\n%s", text)
	}
	// Truncation is announced, so a cut is never read as an absence.
	if !strings.Contains(text, "6 more matched") {
		t.Errorf("truncation not announced:\n%s", text)
	}
}

func TestEmptySearchSaysAbsenceOfEvidence(t *testing.T) {
	s, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"chunks":[],"matchedCount":0,"truncatedCount":0}`))
	})
	res := s.handle(request(t, "tools/call", map[string]any{
		"name": "search_knowledge", "arguments": map[string]any{"query": "quantum tunnelling"},
	}))
	text := res.Result.(map[string]any)["content"].([]map[string]any)[0]["text"].(string)
	if !strings.Contains(text, "not evidence of absence") {
		t.Errorf("an empty result should not read as a refutation:\n%s", text)
	}
}

// Each of the four verdicts has to say something different, or the split that
// the whole citation design rests on is invisible at the point of use.
func TestEveryVerdictReadsDifferently(t *testing.T) {
	seen := map[string]string{}
	for _, verdict := range []string{"supported", "stale", "unsupported", "unknown"} {
		s, _ := newTestServer(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"citation":"knowledge/architecture.md#auth","verdict":"` + verdict + `","note":"","checkedAgainst":[]}`))
		})
		res := s.handle(request(t, "tools/call", map[string]any{
			"name":      "verify_citation",
			"arguments": map[string]any{"citation": "knowledge/architecture.md#auth"},
		}))
		text := res.Result.(map[string]any)["content"].([]map[string]any)[0]["text"].(string)
		for other, otherText := range seen {
			if otherText == text {
				t.Fatalf("%q and %q produce identical output", verdict, other)
			}
		}
		seen[verdict] = text
	}
	if !strings.Contains(seen["unknown"], "not a refutation") {
		t.Error("unknown must not read as unsupported — that distinction is the point")
	}
}

// serve() owns stdout, and the client parses every byte of it. One frame per
// request, nothing for a notification, and no stray prose anywhere.
func TestServeWritesOneFramePerRequestAndNothingForNotifications(t *testing.T) {
	s, out := newTestServer(t, nil)
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize"}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"ping"}`,
	}, "\n")
	if err := s.serve(strings.NewReader(in)); err != nil {
		t.Fatalf("serve: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("wrote %d frames, want 2 (the notification must draw none):\n%s", len(lines), out.String())
	}
	for _, line := range lines {
		var res map[string]any
		if err := json.Unmarshal([]byte(line), &res); err != nil {
			t.Fatalf("stdout carried something that is not JSON-RPC: %q", line)
		}
		if res["jsonrpc"] != "2.0" {
			t.Errorf("frame is not JSON-RPC 2.0: %q", line)
		}
	}
}

func TestServeStopsCleanlyAtEndOfInput(t *testing.T) {
	s, _ := newTestServer(t, nil)
	if err := s.serve(strings.NewReader("")); err != nil {
		t.Fatalf("an empty stream is a client that hung up, not an error: %v", err)
	}
}
