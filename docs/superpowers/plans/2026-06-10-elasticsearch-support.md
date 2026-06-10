# Elasticsearch Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Elasticsearch support across Go Sidecar, Rust Backend, and Vue Frontend following existing MySQL/Redis patterns.

**Architecture:** Go sidecar (`go-elasticsearch v8`) → Rust thin pass-through commands → Vue3 frontend with dedicated `ElasticsearchView.vue` + connection form + routing.

**Tech Stack:** Go 1.25, go-elasticsearch/v8, Rust/Tauri 2, Vue 3 + Vite + TypeScript, Vuetify 3, Pinia.

---

## Task 1: Go Sidecar — Add ES dependency and pool constant

**Files:**
- Modify: `sidecar/pool/manager.go:13-17`
- Modify: `sidecar/go.mod`

- [ ] **Step 1: Add ConnES constant to pool/manager.go**

```go
const (
	ConnMySQL  ConnType = "mysql"
	ConnRedis  ConnType = "redis"
	ConnDocker ConnType = "docker"
	ConnES     ConnType = "elasticsearch"
)
```

- [ ] **Step 2: Add go-elasticsearch dependency**

```
cd sidecar && go get github.com/elastic/go-elasticsearch/v8
```

Expected: go.mod updated with the new dependency and go.sum regenerated.

- [ ] **Step 3: Verify build compiles**

```
cd sidecar && go build ./...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add sidecar/pool/manager.go sidecar/go.mod sidecar/go.sum
git commit -m "chore(sidecar): add elasticsearch pool constant and go-elasticsearch v8 dep"
```

---

## Task 2: Go Sidecar — Create ElasticsearchAdapter

**Files:**
- Create: `sidecar/adapters/elasticsearch.go`

- [ ] **Step 1: Create `sidecar/adapters/elasticsearch.go`**

```go
package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/elastic/go-elasticsearch/v8"
	"github.com/elastic/go-elasticsearch/v8/esapi"
)

// ElasticsearchConnInfo holds connection parameters
type ElasticsearchConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	UseSSL   bool   `json:"useSSL"`
	APIKey   string `json:"apiKey"`
}

// ElasticsearchAdapter wraps the ES client
type ElasticsearchAdapter struct {
	client      *elasticsearch.Client
	connInfo    ElasticsearchConnInfo
	clusterName string
	version     string
}

// NewElasticsearchAdapter creates a new ES adapter
func NewElasticsearchAdapter(info *ElasticsearchConnInfo) (*ElasticsearchAdapter, error) {
	if info.Host == "" {
		info.Host = "localhost"
	}
	if info.Port == 0 {
		info.Port = 9200
	}

	scheme := "http"
	if info.UseSSL {
		scheme = "https"
	}
	addr := fmt.Sprintf("%s://%s:%d", scheme, info.Host, info.Port)

	cfg := elasticsearch.Config{
		Addresses: []string{addr},
		Username:  info.Username,
		Password:  info.Password,
		APIKey:    info.APIKey,
	}

	client, err := elasticsearch.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create ES client: %w", err)
	}

	adapter := &ElasticsearchAdapter{
		client:   client,
		connInfo: *info,
	}

	// Fetch cluster info on connect
	res, err := client.Info()
	if err != nil {
		return nil, fmt.Errorf("failed to get ES info: %w", err)
	}
	defer res.Body.Close()

	if res.IsError() {
		return nil, fmt.Errorf("ES info error: %s", res.String())
	}

	var infoResp struct {
		ClusterName string `json:"cluster_name"`
		Version     struct {
			Number string `json:"number"`
		} `json:"version"`
	}
	if err := json.NewDecoder(res.Body).Decode(&infoResp); err != nil {
		return nil, fmt.Errorf("failed to parse ES info: %w", err)
	}
	adapter.clusterName = infoResp.ClusterName
	adapter.version = infoResp.Version.Number

	return adapter, nil
}

func (a *ElasticsearchAdapter) Close() error {
	// go-elasticsearch v8 doesn't have explicit Close; connections are pooled internally
	return nil
}

func (a *ElasticsearchAdapter) Ping() error {
	res, err := a.client.Ping()
	if err != nil {
		return fmt.Errorf("ping failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return fmt.Errorf("ping error: %s", res.String())
	}
	return nil
}

// ─── Result Types ───

type ClusterHealthInfo struct {
	ClusterName         string  `json:"clusterName"`
	Status              string  `json:"status"`
	NumberOfNodes       int     `json:"numberOfNodes"`
	NumberOfDataNodes   int     `json:"numberOfDataNodes"`
	ActivePrimaryShards int     `json:"activePrimaryShards"`
	ActiveShards        int     `json:"activeShards"`
	ActiveShardsPercent float64 `json:"activeShardsPercent"`
}

type IndexInfo struct {
	Name          string `json:"name"`
	DocsCount     int64  `json:"docsCount"`
	StoreSize     string `json:"storeSize"`
	Health        string `json:"health"`
	Status        string `json:"status"`
	PrimaryShards int    `json:"primaryShards"`
	ReplicaShards int    `json:"replicaShards"`
}

type FieldInfo struct {
	Name     string      `json:"name"`
	Type     string      `json:"type"`
	Children []FieldInfo `json:"children,omitempty"`
}

type IndexMappingInfo struct {
	IndexName string      `json:"indexName"`
	Fields    []FieldInfo `json:"fields"`
}

type EsSearchResult struct {
	Took         int                    `json:"took"`
	TimedOut     bool                   `json:"timedOut"`
	TotalHits    int64                  `json:"totalHits"`
	MaxScore     *float64               `json:"maxScore"`
	Hits         []EsSearchHit          `json:"hits"`
	Aggregations map[string]interface{} `json:"aggregations"`
}

type EsSearchHit struct {
	Index  string                 `json:"index"`
	ID     string                 `json:"id"`
	Score  *float64               `json:"score"`
	Source map[string]interface{} `json:"source"`
}

type DocumentResult struct {
	Index   string                 `json:"index"`
	ID      string                 `json:"id"`
	Version int64                  `json:"version"`
	Found   bool                   `json:"found"`
	Source  map[string]interface{} `json:"source"`
}

type BulkResult struct {
	Took   int  `json:"took"`
	Errors bool `json:"errors"`
	Items  []map[string]interface{} `json:"items"`
}

type ScrollResult struct {
	ScrollID  string        `json:"scrollId"`
	TotalHits int64         `json:"totalHits"`
	Hits      []EsSearchHit `json:"hits"`
}

// ─── Cluster Methods ───

func (a *ElasticsearchAdapter) ClusterHealth() (*ClusterHealthInfo, error) {
	res, err := a.client.Cluster.Health()
	if err != nil {
		return nil, fmt.Errorf("cluster health failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("cluster health error: %s", res.String())
	}
	var ch ClusterHealthInfo
	if err := json.NewDecoder(res.Body).Decode(&ch); err != nil {
		return nil, fmt.Errorf("failed to parse health: %w", err)
	}
	return &ch, nil
}

func (a *ElasticsearchAdapter) ClusterStats() (map[string]interface{}, error) {
	res, err := a.client.Cluster.Stats()
	if err != nil {
		return nil, fmt.Errorf("cluster stats failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("cluster stats error: %s", res.String())
	}
	var stats map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&stats); err != nil {
		return nil, fmt.Errorf("failed to parse stats: %w", err)
	}
	return stats, nil
}

// ─── Index Methods ───

func (a *ElasticsearchAdapter) ListIndices() ([]IndexInfo, error) {
	res, err := a.client.Cat.Indices(a.client.Cat.Indices.WithFormat("json"))
	if err != nil {
		return nil, fmt.Errorf("list indices failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("list indices error: %s", res.String())
	}
	var raw []map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("failed to parse indices: %w", err)
	}
	indices := make([]IndexInfo, 0, len(raw))
	for _, r := range raw {
		info := IndexInfo{
			Name:    getString(r, "index"),
			Health:  getString(r, "health"),
			Status:  getString(r, "status"),
		}
		if v := getInt(r, "docs.count"); v > 0 {
			info.DocsCount = v
		}
		if v := getString(r, "store.size"); v != "" {
			info.StoreSize = v
		}
		if v := getInt(r, "pri"); v > 0 {
			info.PrimaryShards = int(v)
		}
		if v := getInt(r, "rep"); v > 0 {
			info.ReplicaShards = int(v)
		}
		indices = append(indices, info)
	}
	return indices, nil
}

func (a *ElasticsearchAdapter) GetMapping(index string) (*IndexMappingInfo, error) {
	res, err := a.client.Indices.GetMapping(a.client.Indices.GetMapping.WithIndex(index))
	if err != nil {
		return nil, fmt.Errorf("get mapping failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("get mapping error: %s", res.String())
	}
	var raw map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("failed to parse mapping: %w", err)
	}
	info := &IndexMappingInfo{IndexName: index}
	if idxData, ok := raw[index]; ok {
		if idxMap, ok := idxData.(map[string]interface{}); ok {
			if mappings, ok := idxMap["mappings"].(map[string]interface{}); ok {
				if props, ok := mappings["properties"].(map[string]interface{}); ok {
					info.Fields = parseMappingFields(props)
				}
			}
		}
	}
	return info, nil
}

func parseMappingFields(props map[string]interface{}) []FieldInfo {
	fields := make([]FieldInfo, 0, len(props))
	for name, val := range props {
		prop, ok := val.(map[string]interface{})
		if !ok {
			continue
		}
		f := FieldInfo{
			Name: name,
			Type: getString(prop, "type"),
		}
		if nestedProps, ok := prop["properties"].(map[string]interface{}); ok {
			f.Children = parseMappingFields(nestedProps)
		}
		fields = append(fields, f)
	}
	return fields
}

func (a *ElasticsearchAdapter) GetSettings(index string) (map[string]interface{}, error) {
	res, err := a.client.Indices.GetSettings(a.client.Indices.GetSettings.WithIndex(index))
	if err != nil {
		return nil, fmt.Errorf("get settings failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("get settings error: %s", res.String())
	}
	var raw map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func (a *ElasticsearchAdapter) CreateIndex(index string, mappings map[string]interface{}, settings map[string]interface{}) (map[string]interface{}, error) {
	body := map[string]interface{}{}
	if mappings != nil {
		body["mappings"] = mappings
	}
	if settings != nil {
		body["settings"] = settings
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, err
	}
	res, err := a.client.Indices.Create(index, a.client.Indices.Create.WithBody(&buf))
	if err != nil {
		return nil, fmt.Errorf("create index failed: %w", err)
	}
	defer res.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(res.Body).Decode(&result)
	return result, nil
}

func (a *ElasticsearchAdapter) DeleteIndex(index string) (map[string]interface{}, error) {
	res, err := a.client.Indices.Delete([]string{index})
	if err != nil {
		return nil, fmt.Errorf("delete index failed: %w", err)
	}
	defer res.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(res.Body).Decode(&result)
	return result, nil
}

// ─── Search Methods ───

func (a *ElasticsearchAdapter) Search(index string, body map[string]interface{}, from, size int) (*EsSearchResult, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, fmt.Errorf("failed to encode query: %w", err)
	}

	opts := []func(*esapi.SearchRequest){
		a.client.Search.WithIndex(index),
		a.client.Search.WithBody(&buf),
		a.client.Search.WithFrom(from),
		a.client.Search.WithSize(size),
		a.client.Search.WithTrackTotalHits(true),
	}

	res, err := a.client.Search(opts...)
	if err != nil {
		return nil, fmt.Errorf("search failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("search error: %s", res.String())
	}

	var raw struct {
		Took     int  `json:"took"`
		TimedOut bool `json:"timed_out"`
		Hits     struct {
			Total struct {
				Value    int64  `json:"value"`
				Relation string `json:"relation"`
			} `json:"total"`
			MaxScore *float64 `json:"max_score"`
			Hits     []struct {
				Index  string                  `json:"_index"`
				ID     string                  `json:"_id"`
				Score  *float64                `json:"_score"`
				Source map[string]interface{}  `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
		Aggregations map[string]interface{} `json:"aggregations"`
	}

	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("failed to parse search result: %w", err)
	}

	result := &EsSearchResult{
		Took:         raw.Took,
		TimedOut:     raw.TimedOut,
		TotalHits:    raw.Hits.Total.Value,
		MaxScore:     raw.Hits.MaxScore,
		Aggregations: raw.Aggregations,
		Hits:         make([]EsSearchHit, 0, len(raw.Hits.Hits)),
	}
	for _, h := range raw.Hits.Hits {
		hit := EsSearchHit{
			Index:  h.Index,
			ID:     h.ID,
			Score:  h.Score,
			Source: h.Source,
		}
		if hit.Source == nil {
			hit.Source = map[string]interface{}{}
		}
		result.Hits = append(result.Hits, hit)
	}
	return result, nil
}

func (a *ElasticsearchAdapter) Count(index string, body map[string]interface{}) (int64, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return 0, err
		}
	}
	opts := []func(*esapi.CountRequest){
		a.client.Count.WithIndex(index),
	}
	if body != nil {
		opts = append(opts, a.client.Count.WithBody(&buf))
	}
	res, err := a.client.Count(opts...)
	if err != nil {
		return 0, fmt.Errorf("count failed: %w", err)
	}
	defer res.Body.Close()
	var raw struct {
		Count int64 `json:"count"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return 0, err
	}
	return raw.Count, nil
}

// ─── Document CRUD Methods ───

func (a *ElasticsearchAdapter) GetDocument(index, id string) (*DocumentResult, error) {
	res, err := a.client.Get(index, id)
	if err != nil {
		return nil, fmt.Errorf("get document failed: %w", err)
	}
	defer res.Body.Close()
	var raw struct {
		Index   string                 `json:"_index"`
		ID      string                 `json:"_id"`
		Version int64                  `json:"_version"`
		Found   bool                   `json:"found"`
		Source  map[string]interface{} `json:"_source"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("failed to parse document: %w", err)
	}
	return &DocumentResult{
		Index:   raw.Index,
		ID:      raw.ID,
		Version: raw.Version,
		Found:   raw.Found,
		Source:  raw.Source,
	}, nil
}

func (a *ElasticsearchAdapter) IndexDocument(index, id string, body map[string]interface{}) (map[string]interface{}, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, err
	}
	res, err := a.client.Index(index, bytes.NewReader(buf.Bytes()), a.client.Index.WithDocumentID(id))
	if err != nil {
		return nil, fmt.Errorf("index document failed: %w", err)
	}
	defer res.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(res.Body).Decode(&result)
	return result, nil
}

func (a *ElasticsearchAdapter) UpdateDocument(index, id string, body map[string]interface{}) (map[string]interface{}, error) {
	docBody := map[string]interface{}{"doc": body}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(docBody); err != nil {
		return nil, err
	}
	res, err := a.client.Update(index, id, bytes.NewReader(buf.Bytes()))
	if err != nil {
		return nil, fmt.Errorf("update document failed: %w", err)
	}
	defer res.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(res.Body).Decode(&result)
	return result, nil
}

func (a *ElasticsearchAdapter) DeleteDocument(index, id string) (map[string]interface{}, error) {
	res, err := a.client.Delete(index, id)
	if err != nil {
		return nil, fmt.Errorf("delete document failed: %w", err)
	}
	defer res.Body.Close()
	var result map[string]interface{}
	json.NewDecoder(res.Body).Decode(&result)
	return result, nil
}

// ─── Bulk & Export Methods ───

func (a *ElasticsearchAdapter) BulkIndex(index string, documents []map[string]interface{}) (*BulkResult, error) {
	var buf bytes.Buffer
	for _, doc := range documents {
		action := map[string]interface{}{
			"index": map[string]interface{}{
				"_index": index,
			},
		}
		actionBytes, _ := json.Marshal(action)
		docBytes, _ := json.Marshal(doc)
		buf.Write(actionBytes)
		buf.WriteByte('\n')
		buf.Write(docBytes)
		buf.WriteByte('\n')
	}

	res, err := a.client.Bulk(bytes.NewReader(buf.Bytes()))
	if err != nil {
		return nil, fmt.Errorf("bulk index failed: %w", err)
	}
	defer res.Body.Close()
	var result BulkResult
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse bulk result: %w", err)
	}
	return &result, nil
}

func (a *ElasticsearchAdapter) ExportDocuments(index string, body map[string]interface{}, size int) ([]map[string]interface{}, error) {
	// Use simple search for exports up to specified size
	searchRes, err := a.Search(index, body, 0, size)
	if err != nil {
		return nil, err
	}
	docs := make([]map[string]interface{}, 0, len(searchRes.Hits))
	for _, hit := range searchRes.Hits {
		docs = append(docs, hit.Source)
	}
	return docs, nil
}

func (a *ElasticsearchAdapter) ScrollSearch(index string, body map[string]interface{}, size int) (*ScrollResult, error) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(body); err != nil {
		return nil, err
	}
	res, err := a.client.Search(
		a.client.Search.WithIndex(index),
		a.client.Search.WithBody(&buf),
		a.client.Search.WithSize(size),
		a.client.Search.WithScroll(2*time.Minute),
	)
	if err != nil {
		return nil, fmt.Errorf("scroll search failed: %w", err)
	}
	defer res.Body.Close()

	var raw struct {
		ScrollID string `json:"_scroll_id"`
		Hits     struct {
			Total struct {
				Value int64 `json:"value"`
			} `json:"total"`
			Hits []struct {
				Index  string                 `json:"_index"`
				ID     string                 `json:"_id"`
				Score  *float64               `json:"_score"`
				Source map[string]interface{} `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, err
	}

	result := &ScrollResult{
		ScrollID:  raw.ScrollID,
		TotalHits: raw.Hits.Total.Value,
		Hits:      make([]EsSearchHit, 0, len(raw.Hits.Hits)),
	}
	for _, h := range raw.Hits.Hits {
		source := h.Source
		if source == nil {
			source = map[string]interface{}{}
		}
		result.Hits = append(result.Hits, EsSearchHit{
			Index:  h.Index,
			ID:     h.ID,
			Score:  h.Score,
			Source: source,
		})
	}
	return result, nil
}

// ─── Helpers ───

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func getInt(m map[string]interface{}, key string) int64 {
	if v, ok := m[key]; ok {
		switch val := v.(type) {
		case float64:
			return int64(val)
		case string:
			// cat API sometimes returns numbers as strings like "12345"
			if n, err := fmt.Sscanf(strings.TrimSpace(val), "%d", new(int64)); err == nil && n == 1 {
				var i int64
				fmt.Sscanf(val, "%d", &i)
				return i
			}
		}
	}
	return 0
}
```

- [ ] **Step 2: Verify build**

```
cd sidecar && go build ./...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add sidecar/adapters/elasticsearch.go
git commit -m "feat(sidecar): add ElasticsearchAdapter with 19 methods"
```

---

## Task 3: Go Sidecar — Register ES RPC handlers

**Files:**
- Modify: `sidecar/adapters/handlers.go`
- Modify: `sidecar/main.go`

- [ ] **Step 1: Add ES handler registration block in `handlers.go`**

At the end of `RegisterDBHandlers()` (after line 57, before the closing `}`), add:

```go
	// Elasticsearch
	server.Register("db.es.connect", handleESConnect(mgr))
	server.Register("db.es.test", handleESTest())
	server.Register("db.es.disconnect", handleDisconnect(mgr))
	server.Register("db.es.clusterHealth", handleESClusterHealth(mgr))
	server.Register("db.es.clusterStats", handleESClusterStats(mgr))
	server.Register("db.es.listIndices", handleESListIndices(mgr))
	server.Register("db.es.getIndexMapping", handleESGetMapping(mgr))
	server.Register("db.es.getIndexSettings", handleESGetSettings(mgr))
	server.Register("db.es.createIndex", handleESCreateIndex(mgr))
	server.Register("db.es.deleteIndex", handleESDeleteIndex(mgr))
	server.Register("db.es.search", handleESSearch(mgr))
	server.Register("db.es.count", handleESCount(mgr))
	server.Register("db.es.getDocument", handleESGetDocument(mgr))
	server.Register("db.es.indexDocument", handleESIndexDocument(mgr))
	server.Register("db.es.updateDocument", handleESUpdateDocument(mgr))
	server.Register("db.es.deleteDocument", handleESDeleteDocument(mgr))
	server.Register("db.es.bulkIndex", handleESBulkIndex(mgr))
	server.Register("db.es.exportJSON", handleESExportJSON(mgr))
	server.Register("db.es.scrollSearch", handleESScrollSearch(mgr))
```

- [ ] **Step 2: Add ES handler functions at end of `handlers.go` (before the last line)**

Insert after the Docker handlers section (before end of file):

```go
// ─── Elasticsearch Handlers ───

func getESAdapter(mgr *pool.Manager, connID string) (*ElasticsearchAdapter, error) {
	adapter, info, err := mgr.Get(connID)
	if err != nil {
		return nil, err
	}
	if info.Type != pool.ConnES {
		return nil, fmt.Errorf("connection %s is not Elasticsearch (type=%s)", connID, info.Type)
	}
	return adapter.(*ElasticsearchAdapter), nil
}

func handleESConnect(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info ElasticsearchConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := NewElasticsearchAdapter(&info)
		if err != nil {
			return nil, err
		}
		connID := fmt.Sprintf("es_%s_%d_%d", info.Host, info.Port, time.Now().UnixNano())
		mgr.Register(connID, adapter, pool.ConnInfo{
			ID:   connID,
			Type: pool.ConnES,
			Host: info.Host,
			Port: info.Port,
		})
		return map[string]interface{}{
			"connId":      connID,
			"host":        info.Host,
			"port":        info.Port,
			"clusterName": adapter.clusterName,
			"version":     adapter.version,
		}, nil
	}
}

func handleESTest() Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info ElasticsearchConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		start := time.Now()
		adapter, err := NewElasticsearchAdapter(&info)
		if err != nil {
			return map[string]interface{}{"ok": false, "message": err.Error()}, nil
		}
		defer adapter.Close()
		if err := adapter.Ping(); err != nil {
			return map[string]interface{}{"ok": false, "message": err.Error()}, nil
		}
		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (es@%s:%d)", elapsed, info.Host, info.Port),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleESClusterHealth(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct{ ConnID string `json:"connId"` }
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ClusterHealth()
	}
}

func handleESClusterStats(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct{ ConnID string `json:"connId"` }
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ClusterStats()
	}
}

func handleESListIndices(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct{ ConnID string `json:"connId"` }
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ListIndices()
	}
}

func handleESGetMapping(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetMapping(p.Index)
	}
}

func handleESGetSettings(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetSettings(p.Index)
	}
}

func handleESCreateIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string                 `json:"connId"`
			Index    string                 `json:"index"`
			Mappings map[string]interface{} `json:"mappings,omitempty"`
			Settings map[string]interface{} `json:"settings,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.CreateIndex(p.Index, p.Mappings, p.Settings)
	}
}

func handleESDeleteIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.DeleteIndex(p.Index)
	}
}

func handleESSearch(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body"`
			From   int                    `json:"from,omitempty"`
			Size   int                    `json:"size,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Size <= 0 {
			p.Size = 20
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.Search(p.Index, p.Body, p.From, p.Size)
	}
}

func handleESCount(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		count, err := adapter.Count(p.Index, p.Body)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"count": count}, nil
	}
}

func handleESGetDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
			ID     string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.GetDocument(p.Index, p.ID)
	}
}

func handleESIndexDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			ID     string                 `json:"id,omitempty"`
			Body   map[string]interface{} `json:"body"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.IndexDocument(p.Index, p.ID, p.Body)
	}
}

func handleESUpdateDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			ID     string                 `json:"id"`
			Body   map[string]interface{} `json:"body"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.UpdateDocument(p.Index, p.ID, p.Body)
	}
}

func handleESDeleteDocument(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string `json:"connId"`
			Index  string `json:"index"`
			ID     string `json:"id"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.DeleteDocument(p.Index, p.ID)
	}
}

func handleESBulkIndex(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string                   `json:"connId"`
			Index     string                   `json:"index"`
			Documents []map[string]interface{} `json:"documents"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.BulkIndex(p.Index, p.Documents)
	}
}

func handleESExportJSON(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body,omitempty"`
			Size   int                    `json:"size,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Size <= 0 {
			p.Size = 1000
		}
		if p.Body == nil {
			p.Body = map[string]interface{}{"query": map[string]interface{}{"match_all": map[string]interface{}{}}}
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		docs, err := adapter.ExportDocuments(p.Index, p.Body, p.Size)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"documents": docs, "count": len(docs)}, nil
	}
}

func handleESScrollSearch(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID string                 `json:"connId"`
			Index  string                 `json:"index"`
			Body   map[string]interface{} `json:"body"`
			Size   int                    `json:"size,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if p.Size <= 0 {
			p.Size = 100
		}
		adapter, err := getESAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		return adapter.ScrollSearch(p.Index, p.Body, p.Size)
	}
}
```

- [ ] **Step 3: Update version string in `sidecar/main.go`**

Change line 34 from:
```go
			"modules": "mysql,redis",
```
to:
```go
			"modules": "mysql,redis,elasticsearch",
```

- [ ] **Step 4: Verify build**

```
cd sidecar && go build ./...
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add sidecar/adapters/handlers.go sidecar/main.go
git commit -m "feat(sidecar): register 19 ES RPC handlers"
```

---

## Task 4: Rust — Add ES Tauri commands

**Files:**
- Modify: `src-tauri/src/commands/db.rs` (append ES commands)
- Modify: `src-tauri/src/main.rs` (register in invoke_handler)

- [ ] **Step 1: Append ES commands at end of `src-tauri/src/commands/db.rs`**

After the last line (after `db_redis_flush_db`), add:

```rust
// ─── Elasticsearch Commands ───

#[tauri::command]
pub async fn db_es_connect(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.es.connect", params).await
}

#[tauri::command]
pub async fn db_es_test(
    sidecar: State<'_, SidecarManager>,
    params: Value,
) -> Result<Value, String> {
    sidecar.call("db.es.test", params).await
}

#[tauri::command]
pub async fn db_es_disconnect(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.es.disconnect", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_es_cluster_health(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.es.clusterHealth", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_es_cluster_stats(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.es.clusterStats", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_es_list_indices(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
) -> Result<Value, String> {
    sidecar.call("db.es.listIndices", serde_json::json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_es_get_index_mapping(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
) -> Result<Value, String> {
    sidecar.call("db.es.getIndexMapping", serde_json::json!({ "connId": conn_id, "index": index })).await
}

#[tauri::command]
pub async fn db_es_get_index_settings(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
) -> Result<Value, String> {
    sidecar.call("db.es.getIndexSettings", serde_json::json!({ "connId": conn_id, "index": index })).await
}

#[tauri::command]
pub async fn db_es_create_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    mappings: Option<Value>,
    settings: Option<Value>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index });
    if let Some(m) = mappings { params["mappings"] = m; }
    if let Some(s) = settings { params["settings"] = s; }
    sidecar.call("db.es.createIndex", params).await
}

#[tauri::command]
pub async fn db_es_delete_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
) -> Result<Value, String> {
    sidecar.call("db.es.deleteIndex", serde_json::json!({ "connId": conn_id, "index": index })).await
}

#[tauri::command]
pub async fn db_es_search(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Value,
    from: Option<usize>,
    size: Option<usize>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index, "body": body });
    if let Some(f) = from { params["from"] = serde_json::json!(f); }
    if let Some(s) = size { params["size"] = serde_json::json!(s); }
    sidecar.call("db.es.search", params).await
}

#[tauri::command]
pub async fn db_es_count(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index });
    if let Some(b) = body { params["body"] = b; }
    sidecar.call("db.es.count", params).await
}

#[tauri::command]
pub async fn db_es_get_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: String,
) -> Result<Value, String> {
    sidecar.call("db.es.getDocument", serde_json::json!({ "connId": conn_id, "index": index, "id": id })).await
}

#[tauri::command]
pub async fn db_es_index_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: Option<String>,
    body: Value,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index, "body": body });
    if let Some(doc_id) = id { params["id"] = serde_json::json!(doc_id); }
    sidecar.call("db.es.indexDocument", params).await
}

#[tauri::command]
pub async fn db_es_update_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: String,
    body: Value,
) -> Result<Value, String> {
    sidecar.call("db.es.updateDocument", serde_json::json!({
        "connId": conn_id, "index": index, "id": id, "body": body
    })).await
}

#[tauri::command]
pub async fn db_es_delete_document(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    id: String,
) -> Result<Value, String> {
    sidecar.call("db.es.deleteDocument", serde_json::json!({
        "connId": conn_id, "index": index, "id": id
    })).await
}

#[tauri::command]
pub async fn db_es_bulk_index(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    documents: Value,
) -> Result<Value, String> {
    sidecar.call("db.es.bulkIndex", serde_json::json!({
        "connId": conn_id, "index": index, "documents": documents
    })).await
}

#[tauri::command]
pub async fn db_es_export_json(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Option<Value>,
    size: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index });
    if let Some(b) = body { params["body"] = b; }
    if let Some(s) = size { params["size"] = serde_json::json!(s); }
    sidecar.call("db.es.exportJSON", params).await
}

#[tauri::command]
pub async fn db_es_scroll_search(
    sidecar: State<'_, SidecarManager>,
    conn_id: String,
    index: String,
    body: Value,
    size: Option<i64>,
) -> Result<Value, String> {
    let mut params = serde_json::json!({ "connId": conn_id, "index": index, "body": body });
    if let Some(s) = size { params["size"] = serde_json::json!(s); }
    sidecar.call("db.es.scrollSearch", params).await
}
```

- [ ] **Step 2: Register ES commands in `src-tauri/src/main.rs`**

In the `invoke_handler` macro, after the Redis commands block (after line 115), add:

```rust
            // Elasticsearch
            commands::db::db_es_connect,
            commands::db::db_es_test,
            commands::db::db_es_disconnect,
            commands::db::db_es_cluster_health,
            commands::db::db_es_cluster_stats,
            commands::db::db_es_list_indices,
            commands::db::db_es_get_index_mapping,
            commands::db::db_es_get_index_settings,
            commands::db::db_es_create_index,
            commands::db::db_es_delete_index,
            commands::db::db_es_search,
            commands::db::db_es_count,
            commands::db::db_es_get_document,
            commands::db::db_es_index_document,
            commands::db::db_es_update_document,
            commands::db::db_es_delete_document,
            commands::db::db_es_bulk_index,
            commands::db::db_es_export_json,
            commands::db::db_es_scroll_search,
```

- [ ] **Step 3: Build Rust**

```
cd src-tauri && cargo build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/db.rs src-tauri/src/main.rs
git commit -m "feat(rust): add 19 ES Tauri commands"
```

---

## Task 5: Frontend — Update Types & Service

**Files:**
- Modify: `src/types/asset.ts`
- Modify: `src/types/db.ts`
- Modify: `src/services/db.ts`

- [ ] **Step 1: Add `'elasticsearch'` to `DatabaseType` in `src/types/asset.ts`**

Change line 3 from:
```ts
export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis'
```
to:
```ts
export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis' | 'elasticsearch'
```

- [ ] **Step 2: Add `'elasticsearch'` and ES types to `src/types/db.ts`**

Change line 1 from:
```ts
export type DatabaseType = 'mysql' | 'redis'
```
to:
```ts
export type DatabaseType = 'mysql' | 'redis' | 'elasticsearch'
```

Add after `DbSession` interface (at end of file):

```ts
// Elasticsearch types
export interface EsConnectParams {
  host: string
  port: number
  username?: string
  password?: string
  useSSL?: boolean
  apiKey?: string
}

export interface EsConnectResult {
  connId: string
  host: string
  port: number
  clusterName: string
  version: string
}

export interface ClusterHealthInfo {
  clusterName: string
  status: 'green' | 'yellow' | 'red'
  numberOfNodes: number
  numberOfDataNodes: number
  activePrimaryShards: number
  activeShards: number
  activeShardsPercent: number
}

export interface EsIndexInfo {
  name: string
  docsCount: number
  storeSize: string
  health: string
  status: string
  primaryShards: number
  replicaShards: number
}

export interface EsFieldInfo {
  name: string
  type: string
  children?: EsFieldInfo[]
}

export interface IndexMappingInfo {
  indexName: string
  fields: EsFieldInfo[]
}

export interface EsSearchResult {
  took: number
  timedOut: boolean
  totalHits: number
  maxScore: number | null
  hits: EsSearchHit[]
  aggregations: Record<string, unknown>
}

export interface EsSearchHit {
  index: string
  id: string
  score: number | null
  source: Record<string, unknown>
}

export interface EsDocument {
  index: string
  id: string
  version: number
  found: boolean
  source: Record<string, unknown>
}

export interface BulkResult {
  took: number
  errors: boolean
  items: Record<string, unknown>[]
}

export interface ScrollResult {
  scrollId: string
  totalHits: number
  hits: EsSearchHit[]
}
```

- [ ] **Step 3: Add ES service functions at end of `src/services/db.ts`**

After the last `redisUnsubscribe` function, add:

```ts
// ─── Elasticsearch ───

export async function esConnect(params: EsConnectParams): Promise<EsConnectResult> {
  return invoke('db_es_connect', { params })
}

export async function esTest(params: EsConnectParams): Promise<TestResult> {
  return invoke('db_es_test', { params })
}

export async function esDisconnect(connId: string): Promise<void> {
  return invoke('db_es_disconnect', { connId })
}

export async function esClusterHealth(connId: string): Promise<ClusterHealthInfo> {
  return invoke('db_es_cluster_health', { connId })
}

export async function esClusterStats(connId: string): Promise<Record<string, unknown>> {
  return invoke('db_es_cluster_stats', { connId })
}

export async function esListIndices(connId: string): Promise<EsIndexInfo[]> {
  return invoke('db_es_list_indices', { connId })
}

export async function esGetMapping(connId: string, index: string): Promise<IndexMappingInfo> {
  return invoke('db_es_get_index_mapping', { connId, index })
}

export async function esGetSettings(connId: string, index: string): Promise<Record<string, unknown>> {
  return invoke('db_es_get_index_settings', { connId, index })
}

export async function esCreateIndex(
  connId: string, index: string,
  mappings?: Record<string, unknown>,
  settings?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return invoke('db_es_create_index', { connId, index, mappings, settings })
}

export async function esDeleteIndex(connId: string, index: string): Promise<Record<string, unknown>> {
  return invoke('db_es_delete_index', { connId, index })
}

export async function esSearch(
  connId: string, index: string, body: Record<string, unknown>,
  from?: number, size?: number
): Promise<EsSearchResult> {
  return invoke('db_es_search', { connId, index, body, from, size })
}

export async function esCount(
  connId: string, index: string, body?: Record<string, unknown>
): Promise<{ count: number }> {
  return invoke('db_es_count', { connId, index, body })
}

export async function esGetDocument(
  connId: string, index: string, id: string
): Promise<EsDocument> {
  return invoke('db_es_get_document', { connId, index, id })
}

export async function esIndexDocument(
  connId: string, index: string, body: Record<string, unknown>, id?: string
): Promise<Record<string, unknown>> {
  return invoke('db_es_index_document', { connId, index, body, id })
}

export async function esUpdateDocument(
  connId: string, index: string, id: string, body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return invoke('db_es_update_document', { connId, index, id, body })
}

export async function esDeleteDocument(
  connId: string, index: string, id: string
): Promise<Record<string, unknown>> {
  return invoke('db_es_delete_document', { connId, index, id })
}

export async function esBulkIndex(
  connId: string, index: string, documents: Record<string, unknown>[]
): Promise<BulkResult> {
  return invoke('db_es_bulk_index', { connId, index, documents })
}

export async function esExportJSON(
  connId: string, index: string, body?: Record<string, unknown>, size?: number
): Promise<{ documents: Record<string, unknown>[]; count: number }> {
  return invoke('db_es_export_json', { connId, index, body, size })
}

export async function esScrollSearch(
  connId: string, index: string, body: Record<string, unknown>, size?: number
): Promise<ScrollResult> {
  return invoke('db_es_scroll_search', { connId, index, body, size })
}
```

- [ ] **Step 4: Update import in `src/services/db.ts`**

At the top of the file, add to the import block:
```ts
import type {
  // ... existing imports ...
  EsConnectParams,
  EsConnectResult,
  ClusterHealthInfo,
  EsIndexInfo,
  IndexMappingInfo,
  EsSearchResult,
  EsDocument,
  BulkResult,
  ScrollResult
} from '@/types/db'
```

- [ ] **Step 5: Commit**

```bash
git add src/types/asset.ts src/types/db.ts src/services/db.ts
git commit -m "feat(frontend): add ES types and service layer"
```

---

## Task 6: Frontend — Update DB Store

**Files:**
- Modify: `src/stores/db.ts`

- [ ] **Step 1: Add `connectElasticsearch` method in store**

After `connectRedis()` (after line 78), add:

```ts
  async function connectElasticsearch(assetId: string, name: string, params: {
    host: string
    port: number
    username?: string
    password?: string
    useSSL?: boolean
    apiKey?: string
  }): Promise<DbSession> {
    const info = await dbService.esConnect(params)
    const session: DbSession = {
      connId: info.connId,
      dbType: 'elasticsearch' as DatabaseType,
      host: info.host,
      port: info.port,
      database: info.clusterName,
      connected: true,
      name,
      assetId
    }
    sessions.value.set(info.connId, session)
    currentConnId.value = info.connId
    return session
  }
```

- [ ] **Step 2: Add ES case in `disconnect()`**

In the disconnect function, add after `else if (session.dbType === 'redis')` block (after line 88):

```ts
      } else if (session.dbType === 'elasticsearch') {
        await dbService.esDisconnect(connId)
```

- [ ] **Step 3: Add `connectElasticsearch` to the return statement**

After `connectRedis,` in the return statement, add:
```ts
    connectElasticsearch,
```

- [ ] **Step 4: Commit**

```bash
git add src/stores/db.ts
git commit -m "feat(frontend): add connectElasticsearch to DB store"
```

---

## Task 7: Frontend — Update DB Connection Form

**Files:**
- Modify: `src/components/db/DbConnectionForm.vue`

- [ ] **Step 1: Add `esApiKey` ref and `esAuthMode` ref**

In the script section, after `const redisDb = ref<number>(...)` (line 38), add:

```ts
const esApiKey = ref(props.initialValues?.apiKey ?? '')
const esAuthMode = ref<'password' | 'apikey'>('password')
```

- [ ] **Step 2: Update `watch(dbType, ...)` for ES port**

Change the watch to include ES case (modify lines 44-49):

```ts
watch(dbType, (type) => {
  if (type === 'mysql') {
    port.value = 3306
  } else if (type === 'redis') {
    port.value = 6379
  } else if (type === 'elasticsearch') {
    port.value = 9200
  }
})
```

- [ ] **Step 3: Update `canSubmit` and `canTest`**

Change `canSubmit`:
```ts
const canSubmit = computed(() => {
  if (!name.value || !host.value) return false
  if (dbType.value === 'mysql') return !!username.value
  if (dbType.value === 'elasticsearch') return esAuthMode.value === 'apikey' ? !!esApiKey.value : true
  return true
})
```

Change `canTest`:
```ts
const canTest = computed(() => {
  if (!host.value) return false
  if (dbType.value === 'mysql') return !!username.value
  if (dbType.value === 'elasticsearch') return esAuthMode.value === 'apikey' ? !!esApiKey.value : true
  return true
})
```

- [ ] **Step 4: Add ES case in `onTestConnection()`**

After the Redis test block (after line 106), add:

```ts
    } else if (dbType.value === 'elasticsearch') {
      const result = await dbService.esTest({
        host: host.value,
        port: port.value,
        username: esAuthMode.value === 'password' ? username.value : undefined,
        password: esAuthMode.value === 'password' ? password.value : undefined,
        useSSL: ssl.value,
        apiKey: esAuthMode.value === 'apikey' ? esApiKey.value : undefined
      })
      testStatus.value = result.ok ? 'success' : 'fail'
      testMessage.value = result.message
```

- [ ] **Step 5: Add ES button in template**

After the Redis button (line 168), add:

```html
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'elasticsearch' }"
        @click="dbType = 'elasticsearch'"
      >
        <v-icon size="16">mdi-database-search</v-icon>
        <span>Elasticsearch</span>
      </div>
```

- [ ] **Step 6: Add ES fields in template (right column)**

After the Redis DB number block (after line 296), add:

```html
        <!-- Elasticsearch 认证方式 -->
        <div v-if="dbType === 'elasticsearch'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-shield-key-outline</v-icon>
            {{ t('db.authMode') }}
          </label>
          <div class="auth-mode-switch">
            <button
              type="button"
              class="auth-mode-btn"
              :class="{ active: esAuthMode === 'password' }"
              @click="esAuthMode = 'password'"
            >
              <v-icon size="12">mdi-lock-outline</v-icon>
              Basic Auth
            </button>
            <button
              type="button"
              class="auth-mode-btn"
              :class="{ active: esAuthMode === 'apikey' }"
              @click="esAuthMode = 'apikey'"
            >
              <v-icon size="12">mdi-key-outline</v-icon>
              API Key
            </button>
          </div>
        </div>

        <!-- Elasticsearch 用户名 (Basic Auth) -->
        <div v-if="dbType === 'elasticsearch' && esAuthMode === 'password'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-account-outline</v-icon>
            {{ t('asset.username') }}
          </label>
          <div class="input-group">
            <span class="input-prefix">@</span>
            <input
              v-model="username"
              type="text"
              class="cyber-input"
              :placeholder="t('asset.placeholderUser')"
            />
          </div>
        </div>

        <!-- Elasticsearch API Key -->
        <div v-if="dbType === 'elasticsearch' && esAuthMode === 'apikey'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-key-outline</v-icon>
            {{ t('db.apiKey') }}
          </label>
          <input
            v-model="esApiKey"
            type="password"
            class="cyber-input mono"
            placeholder="id:api_key"
          />
        </div>
```

- [ ] **Step 7: Add styles for auth-mode switch**

Add at end of the `<style scoped>` block, before `</style>`:

```css
.auth-mode-switch {
  display: flex;
  gap: 6px;
}

.auth-mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: var(--bg-input);
  color: var(--text-2);
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  transition: all 0.2s;
}

.auth-mode-btn.active {
  border-color: var(--purple);
  background: rgba(181, 107, 255, 0.1);
  color: var(--purple);
}

.auth-mode-btn:hover:not(.active) {
  border-color: rgba(181, 107, 255, 0.3);
}
```

- [ ] **Step 8: Commit**

```bash
git add src/components/db/DbConnectionForm.vue
git commit -m "feat(frontend): add ES connection form fields"
```

---

## Task 8: Frontend — Create ElasticsearchView.vue

**Files:**
- Create: `src/views/ElasticsearchView.vue`

- [ ] **Step 1: Create the view file**

```vue
<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDbStore } from '@/stores/db'
import { useAppStore } from '@/stores/app'
import { useI18n } from 'vue-i18n'
import * as esService from '@/services/db'
import type { EsIndexInfo, EsSearchResult } from '@/types/db'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const dbStore = useDbStore()
const appStore = useAppStore()

const instanceId = computed(() => route.params.id as string)
const tab = appStore.tabs.find(t => t.id === instanceId.value)

const session = computed(() => dbStore.sessions.get(connId.value || ''))
const connId = ref<string | null>(null)
const isLoading = ref(false)
const error = ref<string | null>(null)

const activeTab = ref<'overview' | 'search' | 'index' | 'importexport'>('overview')

// Index list
const indices = ref<EsIndexInfo[]>([])
const selectedIndex = ref<string | null>(null)
const indexSearch = ref('')

// Cluster health
const clusterHealth = ref<{ status: string; numberOfNodes: number; activeShardsPercent: number } | null>(null)

// Search
const dslQuery = ref('{\n  "query": {\n    "match_all": {}\n  },\n  "size": 20\n}')
const searchResult = ref<EsSearchResult | null>(null)
const searchLoading = ref(false)
const resultViewMode = ref<'table' | 'json'>('table')
const searchFrom = ref(0)
const searchSize = ref(20)
const searchIndex = ref('')

// Mapping
const mapping = ref<{ indexName: string; fields: { name: string; type: string; children?: { name: string; type: string }[] }[] } | null>(null)
const settings = ref<Record<string, unknown> | null>(null)

const filteredIndices = computed(() => {
  if (!indexSearch.value) return indices.value
  const q = indexSearch.value.toLowerCase()
  return indices.value.filter(i => i.name.toLowerCase().includes(q))
})

const searchColumns = computed(() => {
  if (!searchResult.value?.hits?.length) return []
  const cols = new Set<string>()
  cols.add('_id')
  for (const hit of searchResult.value.hits) {
    for (const key of Object.keys(hit.source)) {
      cols.add(key)
    }
  }
  return Array.from(cols)
})

function getFieldValue(source: Record<string, unknown>, field: string): string {
  if (field === '_id') return ''
  const val = source[field]
  if (val === null || val === undefined) return ''
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

async function initConnection() {
  if (!tab?.assetId) {
    error.value = 'No asset found'
    return
  }
  // Find session by assetId
  for (const [cid, s] of dbStore.sessions) {
    if (s.assetId === tab.assetId && s.dbType === 'elasticsearch') {
      connId.value = cid
      break
    }
  }
  if (!connId.value) {
    // Try to auto-connect
    try {
      const asset = await import('@/stores/asset').then(m => m.useAssetStore().getAssetById(tab.assetId))
      const config = asset.config
      const info = await import('@/services/db').then(m =>
        m.esConnect({
          host: config.host || 'localhost',
          port: config.port || 9200,
          username: config.username,
          password: config.password,
          useSSL: config.ssl,
        })
      )
      dbStore.connectElasticsearch(tab.assetId, asset.name, config as any)
      connId.value = info.connId
    } catch (e: any) {
      error.value = e?.message || String(e)
      return
    }
  }
  await loadIndices()
  await loadClusterHealth()
}

async function loadClusterHealth() {
  if (!connId.value) return
  try {
    clusterHealth.value = await esService.esClusterHealth(connId.value)
  } catch { /* ignore */ }
}

async function loadIndices() {
  if (!connId.value) return
  isLoading.value = true
  try {
    indices.value = await esService.esListIndices(connId.value)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    isLoading.value = false
  }
}

function selectIndex(name: string) {
  selectedIndex.value = name
  searchIndex.value = name
  activeTab.value = 'index'
}

async function loadMapping(index: string) {
  if (!connId.value) return
  try {
    mapping.value = await esService.esGetMapping(connId.value, index)
    settings.value = await esService.esGetSettings(connId.value, index)
  } catch { /* ignore */ }
}

async function executeSearch() {
  if (!connId.value) return
  searchLoading.value = true
  try {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(dslQuery.value)
    } catch {
      error.value = 'Invalid JSON in DSL query'
      searchLoading.value = false
      return
    }
    const idx = searchIndex.value || (selectedIndex.value || '_all')
    searchResult.value = await esService.esSearch(connId.value, idx, body, searchFrom.value, searchSize.value)
    error.value = null
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    searchLoading.value = false
  }
}

function prevPage() {
  if (searchFrom.value >= searchSize.value) {
    searchFrom.value -= searchSize.value
    executeSearch()
  }
}

function nextPage() {
  if (searchResult.value && searchFrom.value + searchSize.value < searchResult.value.totalHits) {
    searchFrom.value += searchSize.value
    executeSearch()
  }
}

function formatDsl() {
  try {
    const obj = JSON.parse(dslQuery.value)
    dslQuery.value = JSON.stringify(obj, null, 2)
  } catch { /* ignore */ }
}

function showDslTemplate() {
  dslQuery.value = JSON.stringify({
    query: { match_all: {} },
    size: 20,
    sort: [{ _score: { order: 'desc' } }]
  }, null, 2)
}

function getHealthColor(status: string): string {
  if (status === 'green') return 'var(--green)'
  if (status === 'yellow') return 'var(--yellow)'
  return 'var(--red)'
}

function getFieldTypeColor(type: string): string {
  if (type === 'text') return 'var(--cyan)'
  if (type === 'keyword') return 'var(--green)'
  if (type === 'long' || type === 'integer' || type === 'short' || type === 'byte' || type === 'double' || type === 'float') return 'var(--yellow)'
  if (type === 'date') return 'var(--purple)'
  if (type === 'boolean') return 'var(--muted)'
  if (type === 'nested' || type === 'object') return 'var(--pink)'
  return 'var(--text-2)'
}

watch(selectedIndex, async (idx) => {
  if (idx) {
    activeTab.value = 'index'
    await loadMapping(idx)
  }
})

watch(() => route.params.id, () => {
  connId.value = null
  indices.value = []
  selectedIndex.value = null
  searchResult.value = null
  mapping.value = null
})

onMounted(() => {
  initConnection()
})
</script>

<template>
  <div class="es-view">
    <!-- Header -->
    <div class="es-header">
      <div class="header-left">
        <span class="status-dot" :class="session?.connected ? 'online' : 'offline'" />
        <span class="header-label">{{ t('db.elasticsearch') }}</span>
        <template v-if="session">
          <span class="header-sep">·</span>
          <span class="header-host">{{ session.database }}</span>
          <span class="header-sep">·</span>
          <span class="header-host">{{ session.host }}:{{ session.port }}</span>
        </template>
      </div>
      <div class="header-right">
        <button class="cyber-btn-secondary" @click="loadIndices">
          <v-icon size="14">mdi-refresh</v-icon>
          {{ t('common.ok') }}
        </button>
      </div>
    </div>

    <!-- Body -->
    <div class="es-body">
      <!-- Sidebar -->
      <div class="es-sidebar">
        <div class="sidebar-search">
          <input
            v-model="indexSearch"
            type="text"
            class="cyber-input"
            :placeholder="t('common.search') + ' ' + t('db.index') + '...'"
          />
        </div>
        <div class="index-list">
          <div
            v-for="idx in filteredIndices"
            :key="idx.name"
            class="tree-item"
            :class="{ active: selectedIndex === idx.name }"
            @click="selectIndex(idx.name)"
          >
            <div class="tree-item-icon">
              <span class="status-dot" :style="{ backgroundColor: getHealthColor(idx.health) }" />
            </div>
            <div class="tree-item-content">
              <span class="tree-item-label">{{ idx.name }}</span>
              <span class="tree-item-meta">{{ idx.docsCount?.toLocaleString() }} docs</span>
            </div>
          </div>
          <div v-if="filteredIndices.length === 0 && !isLoading" class="empty-state">
            <v-icon size="32">mdi-database-off</v-icon>
            <span>{{ t('common.noData') }}</span>
          </div>
        </div>
      </div>

      <!-- Main Content -->
      <div class="es-main">
        <!-- Tabs -->
        <div class="es-tabs">
          <button
            v-for="tab in [
              { key: 'overview', label: t('home.welcome'), icon: 'mdi-view-dashboard' },
              { key: 'search', label: t('db.query'), icon: 'mdi-magnify' },
              { key: 'index', label: t('db.index'), icon: 'mdi-file-document' },
              { key: 'importexport', label: t('db.export'), icon: 'mdi-import' },
            ]"
            :key="tab.key"
            :class="['cyber-tab', { active: activeTab === tab.key }]"
            @click="activeTab = tab.key as any"
          >
            <v-icon size="14">{{ tab.icon }}</v-icon>
            {{ tab.label }}
          </button>
        </div>

        <!-- Tab: Overview -->
        <div v-if="activeTab === 'overview'" class="es-tab-content">
          <div class="overview-grid">
            <div class="cyber-card cluster-health-card">
              <div class="card-title">
                <span class="status-dot" :style="{ backgroundColor: getHealthColor(clusterHealth?.status || 'red') }" />
                {{ t('db.clusterHealth') }}
              </div>
              <div class="health-stats" v-if="clusterHealth">
                <div class="health-stat">
                  <span class="stat-value" :style="{ color: getHealthColor(clusterHealth.status) }">{{ clusterHealth.status }}</span>
                  <span class="stat-label">Status</span>
                </div>
                <div class="health-stat">
                  <span class="stat-value">{{ clusterHealth.numberOfNodes }}</span>
                  <span class="stat-label">Nodes</span>
                </div>
                <div class="health-stat">
                  <span class="stat-value">{{ clusterHealth.activeShardsPercent.toFixed(1) }}%</span>
                  <span class="stat-label">Active Shards</span>
                </div>
              </div>
            </div>

            <div class="cyber-card">
              <div class="card-title">{{ t('db.indices') }}</div>
              <div class="index-stats-summary">
                <div class="health-stat">
                  <span class="stat-value">{{ indices.length }}</span>
                  <span class="stat-label">Total Indices</span>
                </div>
                <div class="health-stat">
                  <span class="stat-value">{{ indices.reduce((s, i) => s + i.docsCount, 0).toLocaleString() }}</span>
                  <span class="stat-label">Total Docs</span>
                </div>
              </div>
            </div>
          </div>

          <div class="indices-table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ t('asset.name') }}</th>
                  <th>{{ t('db.rows') }}</th>
                  <th>Shards</th>
                  <th>{{ t('sftp.size') }}</th>
                  <th>Health</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="idx in indices" :key="idx.name" @click="selectIndex(idx.name)" class="clickable-row">
                  <td class="mono">{{ idx.name }}</td>
                  <td class="mono">{{ idx.docsCount?.toLocaleString() }}</td>
                  <td class="mono">{{ idx.primaryShards }}P / {{ idx.replicaShards }}R</td>
                  <td class="mono">{{ idx.storeSize }}</td>
                  <td><span class="status-dot" :style="{ backgroundColor: getHealthColor(idx.health) }" /> {{ idx.health }}</td>
                  <td>{{ idx.status }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Tab: Search -->
        <div v-if="activeTab === 'search'" class="es-tab-content search-layout">
          <div class="dsl-editor-panel">
            <div class="panel-header">
              <span>{{ t('db.dslQuery') }}</span>
              <div class="panel-actions">
                <select v-model="searchIndex" class="cyber-input index-select">
                  <option value="">{{ t('db.initialDbHint') }}</option>
                  <option v-for="idx in indices" :key="idx.name" :value="idx.name">{{ idx.name }}</option>
                </select>
                <button class="cyber-btn-secondary action-btn" @click="formatDsl" title="Format">
                  <v-icon size="12">mdi-code-braces</v-icon>
                </button>
                <button class="cyber-btn-secondary action-btn" @click="showDslTemplate" title="Template">
                  <v-icon size="12">mdi-file-document-outline</v-icon>
                </button>
              </div>
            </div>
            <textarea
              v-model="dslQuery"
              class="dsl-editor"
              spellcheck="false"
              @keydown.ctrl.enter.prevent="executeSearch"
            />
            <div class="dsl-footer">
              <div class="shortcut-hint">
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> {{ t('db.execute') }}
              </div>
              <button class="cyber-btn" @click="executeSearch" :disabled="searchLoading">
                <v-icon size="14">{{ searchLoading ? 'mdi-loading mdi-spin' : 'mdi-magnify' }}</v-icon>
                {{ searchLoading ? t('common.loading') : t('db.query') }}
              </button>
            </div>
          </div>

          <div class="result-panel">
            <div v-if="error" class="test-status fail">
              <v-icon size="14">mdi-alert-circle</v-icon>
              {{ error }}
            </div>

            <template v-if="searchResult">
              <div class="result-toolbar">
                <span class="result-info">{{ searchResult.totalHits.toLocaleString() }} hits · {{ searchResult.took }}ms</span>
                <div class="result-actions">
                  <button
                    :class="['view-toggle-btn', { active: resultViewMode === 'table' }]"
                    @click="resultViewMode = 'table'"
                  >{{ t('db.table') }}</button>
                  <button
                    :class="['view-toggle-btn', { active: resultViewMode === 'json' }]"
                    @click="resultViewMode = 'json'"
                  >{{ t('db.json') }}</button>
                </div>
              </div>

              <!-- Table View -->
              <div v-if="resultViewMode === 'table'" class="result-table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th v-for="col in searchColumns" :key="col" class="mono">{{ col }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(hit, hi) in searchResult.hits" :key="hi">
                      <td v-for="col in searchColumns" :key="col" class="mono">
                        {{ col === '_id' ? hit.id : getFieldValue(hit.source, col) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- JSON View -->
              <div v-else class="json-view-wrap">
                <pre class="json-view"><code>{{ JSON.stringify(searchResult.hits.map(h => ({ _id: h.id, _index: h.index, _score: h.score, _source: h.source })), null, 2) }}</code></pre>
              </div>

              <!-- Pagination -->
              <div class="result-pagination">
                <button class="cyber-btn-secondary" :disabled="searchFrom === 0" @click="prevPage">
                  <v-icon size="12">mdi-chevron-left</v-icon>
                </button>
                <span class="mono">{{ searchFrom + 1 }}-{{ Math.min(searchFrom + searchSize, searchResult.totalHits) }} / {{ searchResult.totalHits.toLocaleString() }}</span>
                <button class="cyber-btn-secondary" :disabled="searchFrom + searchSize >= searchResult.totalHits" @click="nextPage">
                  <v-icon size="12">mdi-chevron-right</v-icon>
                </button>
              </div>
            </template>

            <div v-else-if="!searchLoading && !error" class="empty-state">
              <v-icon size="32">mdi-magnify</v-icon>
              <span>{{ t('db.emptyDsl') }}</span>
            </div>
          </div>
        </div>

        <!-- Tab: Index Detail -->
        <div v-if="activeTab === 'index'" class="es-tab-content">
          <div v-if="selectedIndex" class="index-detail">
            <div class="detail-header">
              <h3 class="section-header">
                <span class="section-number">#</span>
                {{ selectedIndex }}
              </h3>
            </div>

            <div v-if="mapping" class="mapping-section">
              <h4 class="sub-title">
                <v-icon size="14">mdi-sitemap</v-icon>
                {{ t('db.mapping') }}
              </h4>
              <div class="mapping-tree">
                <div v-for="field in mapping.fields" :key="field.name" class="mapping-field">
                  <div class="field-row">
                    <span class="field-name mono">{{ field.name }}</span>
                    <span class="field-type-badge" :style="{ color: getFieldTypeColor(field.type), borderColor: getFieldTypeColor(field.type) }">
                      {{ field.type }}
                    </span>
                  </div>
                  <div v-if="field.children?.length" class="field-children">
                    <div v-for="child in field.children" :key="child.name" class="field-row child-row">
                      <span class="field-name mono">↳ {{ child.name }}</span>
                      <span class="field-type-badge" :style="{ color: getFieldTypeColor(child.type), borderColor: getFieldTypeColor(child.type) }">
                        {{ child.type }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="settings" class="settings-section">
              <h4 class="sub-title">
                <v-icon size="14">mdi-cog</v-icon>
                {{ t('db.settings') }}
              </h4>
              <pre class="json-view settings-json"><code>{{ JSON.stringify(settings, null, 2) }}</code></pre>
            </div>
          </div>
          <div v-else class="empty-state">
            <v-icon size="32">mdi-file-document-outline</v-icon>
            <span>Select an index from the sidebar</span>
          </div>
        </div>

        <!-- Tab: Import/Export -->
        <div v-if="activeTab === 'importexport'" class="es-tab-content">
          <div class="importexport-layout">
            <div class="cyber-card">
              <div class="card-title">{{ t('db.importJSON') }}</div>
              <p class="card-desc">JSON file (array of objects or NDJSON)</p>
              <div class="import-placeholder">
                <v-icon size="40">mdi-cloud-upload-outline</v-icon>
                <span>{{ t('db.dragOrClick') }}</span>
              </div>
            </div>

            <div class="cyber-card">
              <div class="card-title">{{ t('db.exportJSON') }}</div>
              <div class="export-controls">
                <select v-model="searchIndex" class="cyber-input">
                  <option value="">Select index...</option>
                  <option v-for="idx in indices" :key="idx.name" :value="idx.name">{{ idx.name }}</option>
                </select>
                <button class="cyber-btn" :disabled="!searchIndex">Export</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Status Bar -->
    <div class="es-statusbar">
      <span class="status-dot" :style="{ backgroundColor: getHealthColor(clusterHealth?.status || 'red') }" />
      <span class="mono">{{ clusterHealth?.status || 'unknown' }}</span>
      <span class="sep">·</span>
      <span class="mono">{{ clusterHealth?.numberOfNodes || 0 }} nodes</span>
      <span class="sep">·</span>
      <span class="mono">{{ indices.length }} indices</span>
    </div>
  </div>
</template>

<style scoped>
.es-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}

.es-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid);
  min-height: 48px;
}

.header-left { display: flex; align-items: center; gap: 8px; }
.header-label { font-weight: 600; color: var(--cyan); }
.header-sep { color: var(--muted); }
.header-host { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-2); }
.header-right { display: flex; gap: 8px; }

.es-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.es-sidebar {
  width: 240px;
  border-right: 1px solid var(--line);
  background: var(--panel-solid);
  display: flex;
  flex-direction: column;
}

.sidebar-search { padding: 10px; border-bottom: 1px solid var(--line); }
.sidebar-search .cyber-input { height: 28px; font-size: 12px; }
.index-list { flex: 1; overflow-y: auto; padding: 6px 0; }

.tree-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  transition: all 0.15s;
  border-left: 2px solid transparent;
}

.tree-item:hover { background: rgba(0, 240, 255, 0.04); }
.tree-item.active {
  border-left-color: var(--cyan);
  background: rgba(0, 240, 255, 0.06);
}

.tree-item-icon { flex-shrink: 0; }
.tree-item-content { flex: 1; min-width: 0; }
.tree-item-label { font-size: 12px; font-family: 'JetBrains Mono', monospace; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-item-meta { font-size: 10px; color: var(--muted); }

.es-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.es-tabs {
  display: flex;
  gap: 0;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid);
}

.cyber-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: none;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

.cyber-tab:hover { color: var(--text); }
.cyber-tab.active {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
}

.es-tab-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

/* Overview */
.overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.health-stats, .index-stats-summary { display: flex; gap: 24px; margin-top: 12px; }
.health-stat { display: flex; flex-direction: column; gap: 4px; }
.stat-value { font-size: 20px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
.stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }

/* Tables */
.indices-table-wrap, .result-table-wrap { overflow-x: auto; margin-top: 8px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.data-table th { text-align: left; padding: 6px 10px; color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--line); }
.data-table td { padding: 5px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
.clickable-row { cursor: pointer; }
.clickable-row:hover { background: rgba(0, 240, 255, 0.04); }

/* Search Layout */
.search-layout { display: flex; gap: 12px; padding: 12px; }
.dsl-editor-panel {
  width: 45%;
  display: flex;
  flex-direction: column;
  background: var(--panel-solid);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.panel-actions { display: flex; gap: 6px; align-items: center; }
.index-select { width: 140px; height: 24px; font-size: 11px; padding: 0 6px; }
.dsl-editor {
  flex: 1;
  background: var(--bg);
  color: var(--text);
  border: none;
  padding: 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: none;
  outline: none;
  tab-size: 2;
}
.dsl-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
}
.result-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.result-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 8px 8px 0 0;
  background: var(--panel-solid);
}
.result-info { font-size: 12px; color: var(--text-2); }
.result-actions { display: flex; gap: 4px; }
.view-toggle-btn {
  padding: 3px 10px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  transition: all 0.2s;
}
.view-toggle-btn.active { background: rgba(0, 240, 255, 0.1); border-color: var(--cyan); color: var(--cyan); }
.json-view-wrap { flex: 1; overflow: auto; padding: 12px; background: var(--bg); border: 1px solid var(--line); border-top: none; border-radius: 0 0 8px 8px; }
.json-view { margin: 0; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
.result-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px;
  font-size: 12px;
  color: var(--text-2);
}

/* Index Detail */
.index-detail { display: flex; flex-direction: column; gap: 16px; }
.detail-header { display: flex; align-items: center; justify-content: space-between; }
.section-header { font-size: 16px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
.section-number { color: var(--cyan); font-family: 'Orbitron', sans-serif; font-size: 14px; }
.sub-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; margin: 0 0 10px; }
.mapping-field { margin-bottom: 4px; }
.field-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
.field-name { font-size: 12px; }
.child-row { padding-left: 20px; }
.field-type-badge {
  font-size: 10px;
  padding: 1px 6px;
  border: 1px solid;
  border-radius: 3px;
  font-family: 'JetBrains Mono', monospace;
}
.mapping-tree { padding: 8px 0; }
.settings-json { max-height: 300px; overflow: auto; background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--line); }

/* Import/Export */
.importexport-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.import-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px;
  border: 2px dashed var(--line-2);
  border-radius: 12px;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.2s;
  margin-top: 12px;
}
.import-placeholder:hover { border-color: var(--cyan); color: var(--cyan); }
.export-controls { display: flex; gap: 10px; margin-top: 12px; align-items: center; }
.export-controls .cyber-input { flex: 1; }

/* Status Bar */
.es-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  border-top: 1px solid var(--line);
  background: var(--panel-solid);
  font-size: 11px;
  color: var(--text-2);
}

.card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.card-desc { font-size: 11px; color: var(--muted); margin: 0 0 8px; }

.sep { color: var(--line-2); }

.mono { font-family: 'JetBrains Mono', monospace; }

/* Reuse existing classes */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: var(--muted);
  font-size: 13px;
}

.shortcut-hint { font-size: 10px; color: var(--muted); }
.shortcut-hint kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 5px;
  background: rgba(0, 240, 255, 0.06);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--cyan);
}

.test-status.fail {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(255, 77, 109, 0.08);
  border: 1px solid rgba(255, 77, 109, 0.2);
  color: var(--red);
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/views/ElasticsearchView.vue
git commit -m "feat(frontend): create ElasticsearchView with 4 tabs"
```

---

## Task 9: Frontend — Add Router, AssetTree, Dialog, i18n

**Files:**
- Modify: `src/router/index.ts`
- Modify: `src/components/asset/AssetTree.vue`
- Modify: `src/components/common/NewConnectionDialog.vue`
- Modify: `src/i18n/zh-CN.ts`
- Modify: `src/i18n/en-US.ts`

- [ ] **Step 1: Add ES route in `src/router/index.ts`**

After the Redis route (after line 38), add:

```ts
        {
          path: 'db/elasticsearch/:id',
          name: 'db-elasticsearch',
          component: () => import('@/views/ElasticsearchView.vue'),
          props: true,
        },
```

- [ ] **Step 2: Update `getDbLabel` in `AssetTree.vue`**

Change the switch (lines 60-68) to include ES:
```ts
function getDbLabel(dbType?: string): string {
  switch (dbType) {
    case 'redis': return 'REDIS'
    case 'postgresql': return 'PG'
    case 'sqlite': return 'SQLITE'
    case 'elasticsearch': return 'ES'
    case 'mysql':
    default: return 'MYSQL'
  }
}
```

- [ ] **Step 3: Update `connectToAsset` in `AssetTree.vue`**

Change line 116 from:
```ts
    router.push({ name: dbType === 'redis' ? 'db-redis' : 'db-mysql', params: { id: instanceId } })
```
to:
```ts
    const routeName = dbType === 'redis' ? 'db-redis' : dbType === 'elasticsearch' ? 'db-elasticsearch' : 'db-mysql'
    router.push({ name: routeName, params: { id: instanceId } })
```

- [ ] **Step 4: Add ES CSS to `AssetTree.vue`**

After line 862 (after `.db-type-label.db-sqlite`), add:
```css
.tree-item .v-icon.db-elasticsearch { color: var(--purple); }
.db-type-label.db-elasticsearch { color: var(--purple); background: rgba(181, 107, 255, 0.12); }
```

- [ ] **Step 5: Update description in `NewConnectionDialog.vue`**

Change line 137 from `<span class="type-desc">MySQL · Redis</span>` to:
```html
                <span class="type-desc">MySQL · Redis · Elasticsearch</span>
```

- [ ] **Step 6: Add ES i18n keys to `zh-CN.ts`**

In the `db` section, add after line 225:
```ts
    elasticsearch: 'Elasticsearch',
    index: '索引',
    indices: '索引列表',
    search: '搜索',
    dslQuery: 'DSL 查询',
    mapping: '映射',
    settings: '设置',
    importJSON: '导入 JSON',
    exportJSON: '导出 JSON',
    clusterHealth: '集群健康',
    documents: '文档',
    newIndex: '新建索引',
    deleteIndex: '删除索引',
    clearIndex: '清空索引',
    documentPreview: '文档预览',
    totalHits: '共 {n} 条结果',
    dragOrClick: '拖拽文件到此处或点击上传',
    importSuccess: '导入成功: {n} 条文档',
    exporting: '导出中...',
    fieldType: '字段类型',
    emptyDsl: '请输入 DSL 查询语句',
    table: '表格',
    json: 'JSON',
    bulkImport: '批量导入',
    authMode: '认证方式',
    apiKey: 'API Key',
```

- [ ] **Step 7: Add ES i18n keys to `en-US.ts`**

In the `db` section, add after line 224:
```ts
    elasticsearch: 'Elasticsearch',
    index: 'Index',
    indices: 'Indices',
    search: 'Search',
    dslQuery: 'DSL Query',
    mapping: 'Mapping',
    settings: 'Settings',
    importJSON: 'Import JSON',
    exportJSON: 'Export JSON',
    clusterHealth: 'Cluster Health',
    documents: 'Documents',
    newIndex: 'New Index',
    deleteIndex: 'Delete Index',
    clearIndex: 'Clear Index',
    documentPreview: 'Document Preview',
    totalHits: '{n} results',
    dragOrClick: 'Drag file here or click to upload',
    importSuccess: 'Import success: {n} docs',
    exporting: 'Exporting...',
    fieldType: 'Field Type',
    emptyDsl: 'Please enter a DSL query',
    table: 'Table',
    json: 'JSON',
    bulkImport: 'Bulk Import',
    authMode: 'Auth Mode',
    apiKey: 'API Key',
```

- [ ] **Step 8: Commit**

```bash
git add src/router/index.ts src/components/asset/AssetTree.vue src/components/common/NewConnectionDialog.vue src/i18n/zh-CN.ts src/i18n/en-US.ts
git commit -m "feat(frontend): integrate ES into router, asset tree, dialog, i18n"
```

---

## Task 10: Documentation & Version Bump

**Files:**
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update AGENTS.md Section 4.3**

Add to the Go Sidecar table:
```
| Elasticsearch | `github.com/elastic/go-elasticsearch/v8` | 官方 |
```

- [ ] **Step 2: Update AGENTS.md Section 2 (current version)**

Change `v0.3.4` to `v0.4.0`.

- [ ] **Step 3: Update CHANGELOG.md**

Add version `[0.4.0] - 2026-06-10` with entry:
```markdown
## [0.4.0] - 2026-06-10

### ✨ feat

- **Elasticsearch**: 新增 ES 连接、集群健康、索引管理、DSL 搜索、文档 CRUD、JSON 导入导出
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md CHANGELOG.md
git commit -m "docs: add Elasticsearch to AGENTS.md and CHANGELOG"
```
