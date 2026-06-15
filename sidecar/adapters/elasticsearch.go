package adapters

import (
	"bytes"
	"encoding/json"
	"fmt"
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
