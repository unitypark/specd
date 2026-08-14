package main

// The knowledge engine, behind a protocol an editor already speaks (0017).
//
// specd built a citation-grade retrieval engine and gave agents a markdown
// file to reach it with. This is the other door: a stdio MCP server that any
// MCP-capable assistant can call, serving exactly what the SpecAgent sees —
// the same three retrieval stages, the same provenance, the same four
// verdicts.
//
// It is read-only, and not as a matter of discipline. The server is a thin
// client over the same HTTP API every other command uses, carrying the same
// CLI-audience token, and the API refuses a CLI token on every route that is
// not marked @CliAllowed. An agent cannot approve a spec through this server
// because the *server* cannot, however it is asked.
//
// Two rules the rest of this file exists to keep:
//
//   - stdout carries JSON-RPC and nothing else. Every other command in this
//     CLI prints freely to stdout; here a stray fmt.Println corrupts the
//     stream and the client disconnects. Diagnostics go to stderr.
//   - a tool failure is a *result*, not a protocol error. "This spec is not
//     approved" is an answer the agent should read and act on; returning a
//     JSON-RPC error would make the client treat it as a broken server.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/specd-dev/specd/cli/internal/api"
	"github.com/specd-dev/specd/cli/internal/config"
)

// The revision of the MCP spec this server implements. Clients send their own
// in `initialize`; we answer with ours and let the client decide.
const mcpProtocolVersion = "2025-06-18"

// ─── JSON-RPC ────────────────────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// JSON-RPC reserves -32601 for an unknown method and -32602 for bad params.
const (
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInvalidParams  = -32602
	rpcInternalError  = -32603
)

// isNotification reports whether a request wants no reply. A notification has
// no id, and answering one is a protocol violation some clients hang up over.
func (r rpcRequest) isNotification() bool {
	return len(r.ID) == 0 || string(r.ID) == "null"
}

// ─── tools ───────────────────────────────────────────────────────────────────

// A tool the server exposes. The shape mirrors replCommands in repl.go: a flat
// table, so adding a tool is one entry and the dispatch never changes.
type mcpTool struct {
	name        string
	description string
	// JSON Schema for the arguments, sent verbatim in tools/list.
	schema map[string]any
	run    func(s *mcpServer, args map[string]any) (string, error)
}

func stringArg(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func intArg(args map[string]any, key string) int {
	// JSON numbers decode as float64 through `any`.
	if v, ok := args[key].(float64); ok {
		return int(v)
	}
	return 0
}

func object(props map[string]any, required ...string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{"type": "object", "properties": props, "required": required}
}

func str(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

var mcpTools = []mcpTool{
	{
		name: "search_knowledge",
		description: "Search this project's knowledge base. Returns passages with the exact " +
			"string to cite them by, plus how each was found — a direct match, a graph " +
			"expansion from a linked doc, or source code a doc references. Use this before " +
			"reading files: it is what the knowledge base exists for.",
		schema: object(map[string]any{
			"query": str("What you want to know, in words. Natural language beats keywords."),
			"limit": map[string]any{
				"type":        "integer",
				"description": "How many ranked passages to retrieve (1-30, default 12). A few more may follow them: linked documents and referenced source code are appended on top.",
				"minimum":     1,
				"maximum":     30,
			},
		}, "query"),
		run: func(s *mcpServer, args map[string]any) (string, error) {
			query := stringArg(args, "query")
			if query == "" {
				return "", errors.New("query is required")
			}
			res, err := s.client.SearchKnowledge(s.project, query, intArg(args, "limit"))
			if err != nil {
				return "", err
			}
			return renderSearch(res), nil
		},
	},
	{
		name: "get_doc",
		description: "Read one knowledge document in full, by its path, with the links it " +
			"makes and the documents that link back to it.",
		schema: object(map[string]any{
			"path": str("Repository path, e.g. knowledge/architecture.md"),
		}, "path"),
		run: func(s *mcpServer, args map[string]any) (string, error) {
			path := stringArg(args, "path")
			if path == "" {
				return "", errors.New("path is required")
			}
			doc, err := s.client.KnowledgeDoc(s.project, path)
			if err != nil {
				return "", err
			}
			return renderDoc(doc), nil
		},
	},
	{
		name: "verify_citation",
		description: "Check whether a citation holds up, before you rely on it. Answers with " +
			"one of four verdicts: supported, stale (the passage describes code that has " +
			"changed since), unsupported (checked and wrong), or unknown (could not be " +
			"checked — which is not the same as wrong).",
		schema: object(map[string]any{
			"citation": str(`A citation like "knowledge/architecture.md#auth", or a bare doc path.`),
		}, "citation"),
		run: func(s *mcpServer, args map[string]any) (string, error) {
			citation := stringArg(args, "citation")
			if citation == "" {
				return "", errors.New("citation is required")
			}
			check, err := s.client.VerifyCitation(s.project, citation)
			if err != nil {
				return "", err
			}
			return renderVerdict(check), nil
		},
	},
	{
		name: "knowledge_health",
		description: "How trustworthy this knowledge base currently is: score, stale and stub " +
			"counts, broken links, and docs whose freshness could not be measured at all.",
		schema: object(map[string]any{}),
		run: func(s *mcpServer, _ map[string]any) (string, error) {
			health, err := s.client.KnowledgeHealth(s.project)
			if err != nil {
				return "", err
			}
			return renderHealth(health), nil
		},
	},
	{
		name: "spec_status",
		description: "Whether a spec has passed the human gate and can be built. Check this " +
			"before implementing anything.",
		schema: object(map[string]any{
			"id": str("Ticket key (CRM-1) or spec id."),
		}, "id"),
		run: func(s *mcpServer, args map[string]any) (string, error) {
			id := stringArg(args, "id")
			if id == "" {
				return "", errors.New("id is required")
			}
			st, err := s.client.SpecStatus(s.project, id)
			if err != nil {
				return "", err
			}
			return renderSpecStatus(st), nil
		},
	},
	{
		name: "spec_pull",
		description: "Fetch an approved spec as markdown — requirements, design claims with " +
			"their citations, and the ordered task list. Refused unless a human has " +
			"approved it; that refusal is the product working, not an error to route around.",
		schema: object(map[string]any{
			"id": str("Ticket key (CRM-1) or spec id."),
		}, "id"),
		run: func(s *mcpServer, args map[string]any) (string, error) {
			id := stringArg(args, "id")
			if id == "" {
				return "", errors.New("id is required")
			}
			markdown, err := s.client.SpecPull(s.project, id)
			if err != nil {
				var apiErr *api.APIError
				if errors.As(err, &apiErr) && apiErr.NotApproved() {
					// Deliberately a normal result: the agent should read this
					// and stop, not retry against a server it thinks is broken.
					return "This spec is not approved, so it cannot be pulled.\n\n" +
						apiErr.Message + "\n\nAsk a human to review it before implementing anything.", nil
				}
				return "", err
			}
			return markdown, nil
		},
	},
	{
		name: "list_specs",
		description: "List this project's specs with their lifecycle state, citation counts " +
			"and approver.",
		schema: object(map[string]any{
			"status": str(`Optional filter, e.g. "in_review", "approved", "delivered".`),
		}),
		run: func(s *mcpServer, args map[string]any) (string, error) {
			specs, err := s.client.Specs(s.project, stringArg(args, "status"))
			if err != nil {
				return "", err
			}
			return renderSpecs(specs), nil
		},
	},
}

func toolByName(name string) (mcpTool, bool) {
	for _, t := range mcpTools {
		if t.name == name {
			return t, true
		}
	}
	return mcpTool{}, false
}

// ─── resources ───────────────────────────────────────────────────────────────

// Ambient state a client can read without spending a tool call. Semantica's
// server does this and it is the right split: "what is waiting for a human"
// is context, not a question.
type mcpResource struct {
	uri         string
	name        string
	description string
	read        func(s *mcpServer) (string, error)
}

var mcpResources = []mcpResource{
	{
		uri:         "specd://knowledge/health",
		name:        "Knowledge health",
		description: "Score, stale and stub counts, broken links.",
		read: func(s *mcpServer) (string, error) {
			health, err := s.client.KnowledgeHealth(s.project)
			if err != nil {
				return "", err
			}
			return renderHealth(health), nil
		},
	},
	{
		uri:         "specd://specs/awaiting-review",
		name:        "Specs awaiting review",
		description: "Specs sitting at the human gate right now.",
		read: func(s *mcpServer) (string, error) {
			specs, err := s.client.Specs(s.project, "in_review")
			if err != nil {
				return "", err
			}
			if len(specs) == 0 {
				return "Nothing waiting on a reviewer.", nil
			}
			return renderSpecs(specs), nil
		},
	},
	{
		uri:         "specd://project/summary",
		name:        "Project summary",
		description: "The current project: repos, specs in review, knowledge health.",
		read: func(s *mcpServer) (string, error) {
			projects, err := s.client.Projects()
			if err != nil {
				return "", err
			}
			for _, p := range projects {
				if p.Slug == s.project {
					return fmt.Sprintf(
						"%s (%s)\n%d repositor(y/ies) · %d spec(s) in review · knowledge health %d%%",
						p.Name, p.Slug, p.RepoCount, p.SpecsInReview, p.KnowledgeHealth), nil
				}
			}
			return fmt.Sprintf("No project %q is visible to this machine.", s.project), nil
		},
	},
}

func resourceByURI(uri string) (mcpResource, bool) {
	for _, r := range mcpResources {
		if r.uri == uri {
			return r, true
		}
	}
	return mcpResource{}, false
}

// ─── rendering ───────────────────────────────────────────────────────────────
//
// Tools answer in text rather than JSON. The consumer is a language model, and
// the CITE-AS layout below is the one the SpecAgent's own prompt uses — an
// agent that reads a passage here and cites it in a spec should have seen it
// in the same shape both times.

func renderSearch(res *api.SearchResult) string {
	if len(res.Chunks) == 0 {
		return "Nothing in the knowledge base matched. That is an absence of evidence, " +
			"not evidence of absence — the base may simply not cover this yet."
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d passage(s), best first.\n", len(res.Chunks))
	if res.TruncatedCount > 0 {
		fmt.Fprintf(&b, "%d more matched and were cut for budget — narrow the query to see them.\n",
			res.TruncatedCount)
	}
	for i, chunk := range res.Chunks {
		provenance := ""
		switch chunk.Via {
		case "graph":
			provenance = "  ← reached via " + chunk.ViaEdge
		case "code":
			provenance = "  ← source code a doc references"
		}
		fmt.Fprintf(&b, "\n[%d] CITE-AS: %s   (repo: %s)%s\n%s\n",
			i+1, chunk.CiteAs, chunk.RepoName, provenance, chunk.Text)
	}
	return b.String()
}

func renderDoc(doc *api.KnowledgeDoc) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s  (%s)\n", doc.Path, doc.Kind)
	if doc.IsStub {
		b.WriteString("This document is a stub — it was scaffolded and never filled in.\n")
	}
	if doc.HasUnverified {
		b.WriteString("Contains UNVERIFIED markers: claims nobody has grounded yet.\n")
	}
	broken := 0
	for _, l := range doc.Outbound {
		if l.State != "resolved" {
			broken++
		}
	}
	if broken > 0 {
		fmt.Fprintf(&b, "%d of its %d outbound link(s) do not resolve.\n", broken, len(doc.Outbound))
	}
	if len(doc.Backlinks) > 0 {
		paths := make([]string, 0, len(doc.Backlinks))
		for _, l := range doc.Backlinks {
			paths = append(paths, l.SourcePath)
		}
		fmt.Fprintf(&b, "Linked from: %s\n", strings.Join(dedupe(paths), ", "))
	}
	b.WriteString("\n---\n\n")
	b.WriteString(doc.Content)
	return b.String()
}

func renderVerdict(check *api.CitationCheck) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s — %s\n", check.Citation, check.Verdict)
	switch check.Verdict {
	case "supported":
		b.WriteString("The cited passage was retrieved and says this.\n")
	case "stale":
		b.WriteString("The passage says this, and describes code that has changed since " +
			"anyone last touched the doc. It may be accurate and out of date.\n")
	case "unsupported":
		b.WriteString("Checked and wrong. Do not cite this.\n")
	case "unknown":
		b.WriteString("Could not be checked from what retrieval could see. That is a gap in " +
			"coverage, not a refutation — confirm it by hand before relying on it.\n")
	}
	if check.Note != "" {
		fmt.Fprintf(&b, "\n%s\n", check.Note)
	}
	return b.String()
}

func renderHealth(h *api.KnowledgeHealth) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Knowledge health: %.0f%% across %d document(s).\n", h.Score, h.DocCount)
	fmt.Fprintf(&b, "%d stale · %d stub · %d as-built · %d broken link(s) · %d dangling anchor(s) · %d orphan(s)\n",
		h.StaleCount, h.StubCount, h.AsBuiltCount, h.BrokenLinks, h.DanglingAnchors, h.OrphanDocs)
	if h.UnknownFreshnessCount > 0 {
		fmt.Fprintf(&b, "%d document(s) have no commit date, so their freshness is unmeasured rather than good.\n",
			h.UnknownFreshnessCount)
	}
	for _, note := range h.Notes {
		fmt.Fprintf(&b, "  %s %s\n", note.Icon, note.Text)
	}
	return b.String()
}

func renderSpecStatus(st *api.SpecStatus) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s  v%d  %s\n", st.TicketKey, st.Version, st.Status)
	if st.Title != "" {
		fmt.Fprintf(&b, "%s\n", st.Title)
	}
	if st.ApprovedBy != "" {
		fmt.Fprintf(&b, "Approved by %s at %s.\n", st.ApprovedBy, st.ApprovedAt)
	}
	if st.Buildable {
		b.WriteString("This spec has passed the gate and can be built.\n")
	} else {
		b.WriteString("This spec has NOT passed the gate. It cannot be pulled or built until " +
			"a named human approves it.\n")
	}
	return b.String()
}

func renderSpecs(specs []api.SpecSummary) string {
	if len(specs) == 0 {
		return "No specs match."
	}
	var b strings.Builder
	for _, s := range specs {
		approver := ""
		if s.ApprovedBy != "" {
			approver = " · approved by " + s.ApprovedBy
		}
		fmt.Fprintf(&b, "%s  v%d  %s  %s  (%d citation(s), %d unverified)%s\n",
			s.Key, s.Version, s.Status, s.Title, s.Citations, s.Unverified, approver)
	}
	return b.String()
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		if seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

// ─── server ──────────────────────────────────────────────────────────────────

type mcpServer struct {
	client  *api.Client
	project string
	out     *json.Encoder
}

// handle answers one request. It returns nil for a notification, which is the
// caller's signal to write nothing at all.
func (s *mcpServer) handle(req rpcRequest) *rpcResponse {
	// A notification carries no id and must draw no reply — for ANY method, not
	// only ones we do not implement. JSON-RPC lets a client send `ping` or any
	// other method as a notification, and answering one with a null-id response
	// is the unsolicited reply that makes some clients hang up. This has to sit
	// above the switch: every case below returns unconditionally, so a check
	// after them only ever guards the methods that fell through.
	if req.isNotification() {
		return nil
	}

	reply := func(result any) *rpcResponse {
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result}
	}
	fail := func(code int, msg string) *rpcResponse {
		return &rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: code, Message: msg}}
	}

	switch req.Method {
	case "initialize":
		return reply(map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities": map[string]any{
				"tools":     map[string]any{},
				"resources": map[string]any{},
			},
			"serverInfo": map[string]any{"name": "specd", "version": version},
			"instructions": "specd serves this project's knowledge base and its approved specs. " +
				"Search the knowledge base before reading files, and cite what you use with the " +
				"CITE-AS string each passage carries. Specs can only be pulled once a human has " +
				"approved them.",
		})

	case "ping":
		return reply(map[string]any{})

	case "tools/list":
		tools := make([]map[string]any, 0, len(mcpTools))
		for _, t := range mcpTools {
			tools = append(tools, map[string]any{
				"name":        t.name,
				"description": t.description,
				"inputSchema": t.schema,
			})
		}
		return reply(map[string]any{"tools": tools})

	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return fail(rpcInvalidParams, "could not read tool call: "+err.Error())
		}
		tool, ok := toolByName(params.Name)
		if !ok {
			return fail(rpcInvalidParams, fmt.Sprintf("no tool named %q", params.Name))
		}
		text, err := tool.run(s, params.Arguments)
		if err != nil {
			// A failed call is a result the agent can read and act on, not a
			// broken server. isError tells it the difference.
			return reply(map[string]any{
				"content": []map[string]any{{"type": "text", "text": err.Error()}},
				"isError": true,
			})
		}
		return reply(map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
		})

	case "resources/list":
		resources := make([]map[string]any, 0, len(mcpResources))
		for _, r := range mcpResources {
			resources = append(resources, map[string]any{
				"uri":         r.uri,
				"name":        r.name,
				"description": r.description,
				"mimeType":    "text/plain",
			})
		}
		return reply(map[string]any{"resources": resources})

	case "resources/read":
		var params struct {
			URI string `json:"uri"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return fail(rpcInvalidParams, "could not read resource request: "+err.Error())
		}
		resource, ok := resourceByURI(params.URI)
		if !ok {
			return fail(rpcInvalidParams, fmt.Sprintf("no resource at %q", params.URI))
		}
		text, err := resource.read(s)
		if err != nil {
			// The uri was fine; reaching the server was not. Reporting this as
			// invalid params sends the model hunting an argument bug that does
			// not exist.
			return fail(rpcInternalError, err.Error())
		}
		return reply(map[string]any{
			"contents": []map[string]any{
				{"uri": params.URI, "mimeType": "text/plain", "text": text},
			},
		})
	}

	return fail(rpcMethodNotFound, fmt.Sprintf("unknown method %q", req.Method))
}

// serve reads newline-delimited JSON-RPC from in and writes replies to out.
func (s *mcpServer) serve(in io.Reader) error {
	reader := bufio.NewReader(in)
	decoder := json.NewDecoder(reader)
	for {
		var req rpcRequest
		if err := decoder.Decode(&req); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			// A *syntax* error leaves the decoder at an unknown position, so
			// there is nothing safe to do but stop. A value-level mismatch is
			// different: the decoder consumed a complete, well-formed JSON
			// value and only failed to fit it into our struct. Killing the
			// session there would end it over a single frame we are positioned
			// to answer — a client on the MCP revision that required JSON-RPC
			// batching opens with an array, and that must not be fatal.
			var syntaxErr *json.SyntaxError
			if errors.As(err, &syntaxErr) {
				return fmt.Errorf("malformed JSON-RPC on stdin: %w", err)
			}
			if err := s.out.Encode(&rpcResponse{
				JSONRPC: "2.0",
				ID:      json.RawMessage("null"),
				Error:   &rpcError{Code: rpcInvalidRequest, Message: err.Error()},
			}); err != nil {
				return err
			}
			continue
		}
		res := s.handle(req)
		if res == nil {
			continue
		}
		if err := s.out.Encode(res); err != nil {
			return err
		}
	}
}

func cmdMCP(args []string) error {
	if len(args) == 0 || args[0] != "serve" {
		return errors.New("usage: specd mcp serve")
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	project, _, err := resolveProject(args[1:], cfg)
	if err != nil {
		return err
	}
	token, err := config.LoadToken()
	if err != nil {
		return err
	}

	// stderr, not stdout: stdout belongs to the protocol from here on.
	fmt.Fprintf(os.Stderr, "specd mcp: serving project %s from %s\n", project, cfg.API)

	server := &mcpServer{
		client:  api.New(cfg.API, token),
		project: project,
		out:     json.NewEncoder(os.Stdout),
	}
	return server.serve(os.Stdin)
}
