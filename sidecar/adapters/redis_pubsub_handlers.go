package adapters

import (
	"encoding/json"
	"fmt"

	"github.com/starhub/sidecar/pool"
)

func handleRedisSubscribe(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID    string   `json:"connId"`
			Channels  []string `json:"channels"`
			Patterns  []string `json:"patterns"`
			TimeoutMs int      `json:"timeoutMs,omitempty"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		messages, err := adapter.Subscribe(p.Channels, p.Patterns, p.TimeoutMs)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{
			"messages": messages,
			"count":    len(messages),
		}, nil
	}
}

func handleRedisUnsubscribe(mgr *pool.Manager) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var p struct {
			ConnID   string   `json:"connId"`
			Channels []string `json:"channels"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, fmt.Errorf("invalid params: %w", err)
		}
		adapter, err := getRedisAdapter(mgr, p.ConnID)
		if err != nil {
			return nil, err
		}
		if err := adapter.Unsubscribe(p.Channels); err != nil {
			return nil, err
		}
		return map[string]interface{}{"ok": true}, nil
	}
}
