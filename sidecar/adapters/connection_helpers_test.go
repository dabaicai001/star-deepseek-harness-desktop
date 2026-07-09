package adapters

import (
	"reflect"
	"testing"
)

func TestKafkaBrokersSupportsCommaSeparatedEndpoints(t *testing.T) {
	got := kafkaBrokers(BrokerConnInfo{Host: "kafka-a, kafka-b:19092", Port: 9092})
	want := []string{"kafka-a:9092", "kafka-b:19092"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("brokers = %#v, want %#v", got, want)
	}
}

func TestShellQuoteProtectsDockerSocketPath(t *testing.T) {
	got := shellQuote("/tmp/docker's.sock")
	want := `'/tmp/docker'"'"'s.sock'`
	if got != want {
		t.Fatalf("shellQuote = %q, want %q", got, want)
	}
}

func TestDockerSSHConfigRequiresTrustedHostKey(t *testing.T) {
	_, err := buildSSHClientConfig("root", "secret", "", "", "")
	if err == nil {
		t.Fatal("expected missing trusted host key to be rejected")
	}
}
