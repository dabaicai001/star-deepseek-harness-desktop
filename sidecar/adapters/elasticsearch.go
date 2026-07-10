package adapters

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/elastic/go-elasticsearch/v8"
	"github.com/elastic/go-elasticsearch/v8/esapi"
)

// ElasticsearchConnInfo holds connection parameters
type ElasticsearchConnInfo struct {
	Addresses []string `json:"addresses"` // multiple node addresses for failover
	Address   string   `json:"address"`   // legacy single address
	Host      string   `json:"host"`
	Port      int      `json:"port"`
	Username  string   `json:"username"`
	Password  string   `json:"password"`
	UseSSL    bool     `json:"useSSL"`
	APIKey    string   `json:"apiKey"`
}

// ElasticsearchAdapter wraps the ES client
type ElasticsearchAdapter struct {
	client      *elasticsearch.Client
	connInfo    ElasticsearchConnInfo
	clusterName string
	version     string
}

// esProductCompatTransport injects X-Elastic-Product header for v7.x nodes
type esProductCompatTransport struct {
	inner http.RoundTripper
}

func (t *esProductCompatTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := t.inner.RoundTrip(req)
	if err != nil {
		return res, err
	}
	if res.Header.Get("X-Elastic-Product") == "" {
		res.Header.Set("X-Elastic-Product", "Elasticsearch")
	}
	return res, nil
}

// probeElasticsearchNode tries a raw HTTP GET to verify the node is Elasticsearch.
// Returns true if this node needs the product header compatibility shim (v7.x).
func probeElasticsearchNode(addr string, username, password, apiKey string) (isES bool, needCompat bool, clusterName string, version string, err error) {
	u := strings.TrimRight(addr, "/") + "/"

	client := &http.Client{Timeout: 8 * time.Second}
	req, reqErr := http.NewRequest("GET", u, nil)
	if reqErr != nil {
		return false, false, "", "", fmt.Errorf("bad address %s: %w", addr, reqErr)
	}
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "ApiKey "+apiKey)
	} else if username != "" {
		req.SetBasicAuth(username, password)
	}

	res, doErr := client.Do(req)
	if doErr != nil {
		return false, false, "", "", doErr
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(res.Body, 8192))

	var info struct {
		ClusterName string `json:"cluster_name"`
		Tagline     string `json:"tagline"`
		Version     struct {
			Number string `json:"number"`
		} `json:"version"`
	}
	if jsonErr := json.Unmarshal(body, &info); jsonErr != nil || info.Version.Number == "" {
		return false, false, "", "", fmt.Errorf("not an Elasticsearch node (HTTP %d): %s", res.StatusCode, string(body[:min(len(body), 200)]))
	}

	isES = true
	clusterName = info.ClusterName
	version = info.Version.Number
	needCompat = res.Header.Get("X-Elastic-Product") != "Elasticsearch"
	return
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// buildVerifiedAddresses resolves all candidate addresses, probes each one,
// and returns verified addresses plus whether compat transport is needed.
func buildVerifiedAddresses(info *ElasticsearchConnInfo) ([]string, bool, string, string, error) {
	var candidates []string

	// collect from addresses array (new multi-node mode)
	for _, a := range info.Addresses {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if !strings.Contains(a, "://") {
			a = "http://" + a
		}
		candidates = append(candidates, strings.TrimRight(a, "/"))
	}

	// collect from legacy single address / host+port
	if len(candidates) == 0 {
		addr, err := buildElasticsearchAddress(info)
		if err != nil {
			return nil, false, "", "", err
		}
		candidates = append(candidates, addr)
	}

	// probe each candidate
	var verified []string
	var needCompat bool
	var clusterName, version string
	var lastErr error

	for _, c := range candidates {
		isES, compat, cn, ver, err := probeElasticsearchNode(c, info.Username, info.Password, info.APIKey)
		if err != nil {
			lastErr = err
			continue
		}
		if !isES {
			continue
		}
		verified = append(verified, c)
		if compat {
			needCompat = true
		}
		if clusterName == "" {
			clusterName = cn
		}
		if version == "" {
			version = ver
		}
	}

	if len(verified) == 0 {
		if lastErr != nil {
			return nil, false, "", "", fmt.Errorf("all %d node(s) failed: %w", len(candidates), lastErr)
		}
		return nil, false, "", "", fmt.Errorf("no Elasticsearch nodes found among %d candidate(s)", len(candidates))
	}

	return verified, needCompat, clusterName, version, nil
}

// NewElasticsearchAdapter creates a new ES adapter.
// Supports multiple node addresses for failover and v7.x compatibility.
func NewElasticsearchAdapter(info *ElasticsearchConnInfo) (*ElasticsearchAdapter, error) {
	addresses, needCompat, clusterName, version, err := buildVerifiedAddresses(info)
	if err != nil {
		return nil, fmt.Errorf("ES probe failed: %w", err)
	}

	cfg := elasticsearch.Config{
		Addresses: addresses,
		Username:  info.Username,
		Password:  info.Password,
		APIKey:    info.APIKey,
	}

	// For v7.x nodes, wrap transport to inject X-Elastic-Product header
	if needCompat {
		baseTransport := http.DefaultTransport
		cfg.Transport = &esProductCompatTransport{inner: baseTransport}
	}

	client, err := elasticsearch.NewClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create ES client: %w", err)
	}

	adapter := &ElasticsearchAdapter{
		client:      client,
		connInfo:    *info,
		clusterName: clusterName,
		version:     version,
	}

	// If we didn't get cluster info from probes, fetch it
	if adapter.clusterName == "" || adapter.version == "" {
		res, infoErr := client.Info()
		if infoErr != nil {
			return nil, fmt.Errorf("failed to get ES info: %w", infoErr)
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
		if jsonErr := json.NewDecoder(res.Body).Decode(&infoResp); jsonErr != nil {
			return nil, fmt.Errorf("failed to parse ES info: %w", jsonErr)
		}
		adapter.clusterName = infoResp.ClusterName
		adapter.version = infoResp.Version.Number
	}

	return adapter, nil
}

func buildElasticsearchAddress(info *ElasticsearchConnInfo) (string, error) {
	address := strings.TrimSpace(info.Address)
	if address == "" && strings.Contains(info.Host, "://") {
		address = strings.TrimSpace(info.Host)
	}
	if address != "" {
		if !strings.Contains(address, "://") {
			address = "http://" + address
		}
		u, err := url.Parse(address)
		if err != nil || u.Host == "" {
			return "", fmt.Errorf("invalid ES address: %s", info.Address)
		}
		info.Host = u.Hostname()
		if portText := u.Port(); portText != "" {
			port, err := strconv.Atoi(portText)
			if err != nil {
				return "", fmt.Errorf("invalid ES address port: %s", portText)
			}
			info.Port = port
		} else if info.Port == 0 {
			if u.Scheme == "https" {
				info.Port = 443
			} else {
				info.Port = 9200
			}
		}
		info.UseSSL = u.Scheme == "https"
		info.Address = strings.TrimRight(address, "/")
		return info.Address, nil
	}

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
	info.Address = fmt.Sprintf("%s://%s:%d", scheme, info.Host, info.Port)
	return info.Address, nil
}

func (a *ElasticsearchAdapter) Close() error {
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

type EsIndexInfo struct {
	Name          string `json:"name"`
	DocsCount     int64  `json:"docsCount"`
	StoreSize     string `json:"storeSize"`
	Health        string `json:"health"`
	Status        string `json:"status"`
	PrimaryShards int    `json:"primaryShards"`
	ReplicaShards int    `json:"replicaShards"`
}

type EsFieldInfo struct {
	Name     string        `json:"name"`
	Type     string        `json:"type"`
	Children []EsFieldInfo `json:"children,omitempty"`
}

type IndexMappingInfo struct {
	IndexName string        `json:"indexName"`
	Fields    []EsFieldInfo `json:"fields"`
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
	Took   int                      `json:"took"`
	Errors bool                     `json:"errors"`
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

func (a *ElasticsearchAdapter) ListIndices() ([]EsIndexInfo, error) {
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
	indices := make([]EsIndexInfo, 0, len(raw))
	for _, r := range raw {
		info := EsIndexInfo{
			Name:   getString(r, "index"),
			Health: getString(r, "health"),
			Status: getString(r, "status"),
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

func parseMappingFields(props map[string]interface{}) []EsFieldInfo {
	fields := make([]EsFieldInfo, 0, len(props))
	for name, val := range props {
		prop, ok := val.(map[string]interface{})
		if !ok {
			continue
		}
		f := EsFieldInfo{
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
	if res.IsError() {
		return nil, fmt.Errorf("create index error: %s", res.String())
	}
	var result map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse create index result: %w", err)
	}
	return result, nil
}

func (a *ElasticsearchAdapter) DeleteIndex(index string) (map[string]interface{}, error) {
	res, err := a.client.Indices.Delete([]string{index})
	if err != nil {
		return nil, fmt.Errorf("delete index failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("delete index error: %s", res.String())
	}
	var result map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse delete index result: %w", err)
	}
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
				Index  string                 `json:"_index"`
				ID     string                 `json:"_id"`
				Score  *float64               `json:"_score"`
				Source map[string]interface{} `json:"_source"`
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
	if res.IsError() {
		return 0, fmt.Errorf("count error: %s", res.String())
	}
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
	if res.IsError() {
		return nil, fmt.Errorf("index document error: %s", res.String())
	}
	var result map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse index document result: %w", err)
	}
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
	if res.IsError() {
		return nil, fmt.Errorf("update document error: %s", res.String())
	}
	var result map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse update document result: %w", err)
	}
	return result, nil
}

func (a *ElasticsearchAdapter) DeleteDocument(index, id string) (map[string]interface{}, error) {
	res, err := a.client.Delete(index, id)
	if err != nil {
		return nil, fmt.Errorf("delete document failed: %w", err)
	}
	defer res.Body.Close()
	if res.IsError() {
		return nil, fmt.Errorf("delete document error: %s", res.String())
	}
	var result map[string]interface{}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse delete document result: %w", err)
	}
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
	if res.IsError() {
		return nil, fmt.Errorf("bulk index error: %s", res.String())
	}
	var result BulkResult
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to parse bulk result: %w", err)
	}
	return &result, nil
}

func (a *ElasticsearchAdapter) ExportDocuments(index string, body map[string]interface{}, size int) ([]map[string]interface{}, error) {
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
			val = strings.TrimSpace(val)
			var i int64
			if _, err := fmt.Sscanf(val, "%d", &i); err == nil {
				return i
			}
		}
	}
	return 0
}
