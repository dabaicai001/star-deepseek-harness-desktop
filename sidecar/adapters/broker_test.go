package adapters

import (
	"strings"
	"testing"
)

func TestParseNsqStatsWithChannels(t *testing.T) {
	body := `{
		"topics": [
			{
				"topic_name": "orders",
				"depth": 12,
				"message_count": 1000,
				"channels": [
					{"channel_name": "worker", "depth": 5, "backlog_count": 5, "message_count": 900},
					{"channel_name": "audit", "depth": 0, "backlog_count": 0, "message_count": 100}
				]
			},
			{"topic_name": "events", "depth": 0, "message_count": 3, "channels": []}
		]
	}`
	resources, err := parseNsqStats(strings.NewReader(body))
	if err != nil {
		t.Fatalf("parseNsqStats: %v", err)
	}
	if len(resources) != 2 {
		t.Fatalf("expected 2 topics, got %d", len(resources))
	}
	orders := resources[1] // 按 name 排序: events, orders
	if orders.Name != "orders" || orders.Channels != 2 || orders.Depth != 12 || orders.Messages != 1000 {
		t.Fatalf("unexpected orders resource: %+v", orders)
	}
	if len(orders.ChannelList) != 2 {
		t.Fatalf("expected 2 channels, got %d", len(orders.ChannelList))
	}
	if orders.ChannelList[0].Name != "worker" || orders.ChannelList[0].Backlog != 5 || orders.ChannelList[0].Messages != 900 {
		t.Fatalf("unexpected channel: %+v", orders.ChannelList[0])
	}
	events := resources[0]
	if events.Channels != 0 || len(events.ChannelList) != 0 {
		t.Fatalf("unexpected events resource: %+v", events)
	}
}
