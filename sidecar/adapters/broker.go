package adapters

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl/plain"
)

type BrokerConnInfo struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	SSL      bool   `json:"ssl,omitempty"`
}

type NSQChannel struct {
	Name     string `json:"name"`
	Depth    int64  `json:"depth,omitempty"`
	Backlog  int64  `json:"backlog,omitempty"`
	Messages int64  `json:"messages,omitempty"`
}

type BrokerResource struct {
	Name        string       `json:"name"`
	Partitions  int          `json:"partitions,omitempty"`
	Channels    int          `json:"channels,omitempty"`
	Depth       int64        `json:"depth,omitempty"`
	Messages    int64        `json:"messages,omitempty"`
	Leader      string       `json:"leader,omitempty"`
	ChannelList []NSQChannel `json:"channelList,omitempty"`
}

type BrokerOverview struct {
	Kind       string           `json:"kind"`
	Status     string           `json:"status"`
	Endpoint   string           `json:"endpoint"`
	NodeCount  int              `json:"nodeCount"`
	Resources  []BrokerResource `json:"resources"`
	ObservedAt int64            `json:"observedAt"`
}

func kafkaBrokers(info BrokerConnInfo) []string {
	hosts := strings.Split(info.Host, ",")
	brokers := make([]string, 0, len(hosts))
	for _, host := range hosts {
		host = strings.TrimSpace(host)
		if host == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(host); err != nil {
			host = net.JoinHostPort(host, fmt.Sprintf("%d", defaultBrokerPort(info.Port, 9092)))
		}
		brokers = append(brokers, host)
	}
	return brokers
}

func kafkaDialer(info BrokerConnInfo) *kafka.Dialer {
	dialer := &kafka.Dialer{Timeout: 10 * time.Second, DualStack: true}
	if info.SSL {
		dialer.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	if info.Username != "" {
		dialer.SASLMechanism = plain.Mechanism{
			Username: info.Username,
			Password: info.Password,
		}
	}
	return dialer
}

func KafkaOverview(info BrokerConnInfo) (*BrokerOverview, error) {
	brokers := kafkaBrokers(info)
	if len(brokers) == 0 {
		return nil, fmt.Errorf("at least one Kafka broker is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	conn, err := kafkaDialer(info).DialContext(ctx, "tcp", brokers[0])
	if err != nil {
		return nil, fmt.Errorf("kafka connect %s: %w", brokers[0], err)
	}
	defer conn.Close()
	partitions, err := conn.ReadPartitions()
	if err != nil {
		return nil, fmt.Errorf("kafka metadata: %w", err)
	}
	type aggregate struct {
		partitions int
		leaders    map[int]struct{}
		leader     string
	}
	topics := make(map[string]*aggregate)
	nodes := make(map[int]struct{})
	for _, partition := range partitions {
		entry := topics[partition.Topic]
		if entry == nil {
			entry = &aggregate{leaders: make(map[int]struct{})}
			topics[partition.Topic] = entry
		}
		entry.partitions++
		entry.leaders[partition.Leader.ID] = struct{}{}
		nodes[partition.Leader.ID] = struct{}{}
		if entry.leader == "" {
			entry.leader = net.JoinHostPort(partition.Leader.Host, fmt.Sprintf("%d", partition.Leader.Port))
		}
	}
	names := make([]string, 0, len(topics))
	for name := range topics {
		names = append(names, name)
	}
	sort.Strings(names)
	resources := make([]BrokerResource, 0, len(names))
	for _, name := range names {
		entry := topics[name]
		resources = append(resources, BrokerResource{
			Name:       name,
			Partitions: entry.partitions,
			Leader:     entry.leader,
		})
	}
	return &BrokerOverview{
		Kind:       "kafka",
		Status:     "online",
		Endpoint:   strings.Join(brokers, ", "),
		NodeCount:  len(nodes),
		Resources:  resources,
		ObservedAt: time.Now().UnixMilli(),
	}, nil
}

func NSQOverview(info BrokerConnInfo) (*BrokerOverview, error) {
	port := defaultBrokerPort(info.Port, 4150)
	tcpEndpoint := net.JoinHostPort(strings.TrimSpace(info.Host), fmt.Sprintf("%d", port))
	conn, err := net.DialTimeout("tcp", tcpEndpoint, 8*time.Second)
	if err != nil {
		return nil, fmt.Errorf("nsqd connect %s: %w", tcpEndpoint, err)
	}
	_ = conn.Close()

	scheme := "http"
	if info.SSL {
		scheme = "https"
	}
	statsURL := fmt.Sprintf("%s://%s/stats?format=json",
		scheme,
		net.JoinHostPort(strings.TrimSpace(info.Host), fmt.Sprintf("%d", port+1)))
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Get(statsURL)
	if err != nil {
		return nil, fmt.Errorf("nsqd stats %s: %w", statsURL, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("nsqd stats returned HTTP %d", response.StatusCode)
	}
	resources, err := parseNsqStats(response.Body)
	if err != nil {
		return nil, err
	}
	return &BrokerOverview{
		Kind:       "nsq",
		Status:     "online",
		Endpoint:   tcpEndpoint,
		NodeCount:  1,
		Resources:  resources,
		ObservedAt: time.Now().UnixMilli(),
	}, nil
}

// parseNsqStats 解析 nsqd /stats?format=json 响应,返回按 name 排序的 topic 列表(含 channel 明细)。
func parseNsqStats(body io.Reader) ([]BrokerResource, error) {
	var payload struct {
		Topics []struct {
			Name         string `json:"topic_name"`
			Depth        int64  `json:"depth"`
			MessageCount int64  `json:"message_count"`
			Channels     []struct {
				Name         string `json:"channel_name"`
				Depth        int64  `json:"depth"`
				Backlog      int64  `json:"backlog_count"`
				MessageCount int64  `json:"message_count"`
			} `json:"channels"`
		} `json:"topics"`
	}
	if err := json.NewDecoder(body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode nsqd stats: %w", err)
	}
	resources := make([]BrokerResource, 0, len(payload.Topics))
	for _, topic := range payload.Topics {
		channels := make([]NSQChannel, 0, len(topic.Channels))
		for _, ch := range topic.Channels {
			channels = append(channels, NSQChannel{
				Name:     ch.Name,
				Depth:    ch.Depth,
				Backlog:  ch.Backlog,
				Messages: ch.MessageCount,
			})
		}
		resources = append(resources, BrokerResource{
			Name:        topic.Name,
			Channels:    len(topic.Channels),
			Depth:       topic.Depth,
			Messages:    topic.MessageCount,
			ChannelList: channels,
		})
	}
	sort.Slice(resources, func(i, j int) bool { return resources[i].Name < resources[j].Name })
	return resources, nil
}

func defaultBrokerPort(port, fallback int) int {
	if port <= 0 {
		return fallback
	}
	return port
}
