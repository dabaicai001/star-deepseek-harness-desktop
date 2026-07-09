package adapters

import (
	"encoding/json"
	"fmt"
	"time"
)

func registerBrokerHandlers(server ServerInterface) {
	server.Register("broker.kafka.test", handleBrokerTest("kafka"))
	server.Register("broker.kafka.overview", handleBrokerOverview("kafka"))
	server.Register("broker.nsq.test", handleBrokerTest("nsq"))
	server.Register("broker.nsq.overview", handleBrokerOverview("nsq"))
}

func handleBrokerTest(kind string) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info BrokerConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid %s params: %w", kind, err)
		}
		start := time.Now()
		overview, err := loadBrokerOverview(kind, info)
		if err != nil {
			return map[string]interface{}{"ok": false, "message": err.Error()}, nil
		}
		elapsed := time.Since(start).Milliseconds()
		return map[string]interface{}{
			"ok":         true,
			"message":    fmt.Sprintf("OK in %dms (%d resources)", elapsed, len(overview.Resources)),
			"elapsed_ms": elapsed,
		}, nil
	}
}

func handleBrokerOverview(kind string) Handler {
	return func(params json.RawMessage) (interface{}, error) {
		var info BrokerConnInfo
		if err := json.Unmarshal(params, &info); err != nil {
			return nil, fmt.Errorf("invalid %s params: %w", kind, err)
		}
		return loadBrokerOverview(kind, info)
	}
}

func loadBrokerOverview(kind string, info BrokerConnInfo) (*BrokerOverview, error) {
	switch kind {
	case "kafka":
		return KafkaOverview(info)
	case "nsq":
		return NSQOverview(info)
	default:
		return nil, fmt.Errorf("unsupported broker: %s", kind)
	}
}
