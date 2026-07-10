package adapters

import (
	"crypto/ed25519"
	"crypto/rand"
	"reflect"
	"testing"

	"golang.org/x/crypto/ssh"
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

func TestDockerSSHConfigPinsTrustedHostKeyAlgorithm(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	sshPublicKey, err := ssh.NewPublicKey(publicKey)
	if err != nil {
		t.Fatalf("new public key: %v", err)
	}

	config, err := buildSSHClientConfig(
		"root",
		"secret",
		"",
		"",
		string(ssh.MarshalAuthorizedKey(sshPublicKey)),
	)
	if err != nil {
		t.Fatalf("build config: %v", err)
	}
	if !reflect.DeepEqual(config.HostKeyAlgorithms, []string{sshPublicKey.Type()}) {
		t.Fatalf("HostKeyAlgorithms = %#v, want %#v", config.HostKeyAlgorithms, []string{sshPublicKey.Type()})
	}
}
