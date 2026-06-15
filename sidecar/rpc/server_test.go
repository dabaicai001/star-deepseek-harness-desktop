package rpc

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRunIOCorrelatesConcurrentResponses(t *testing.T) {
	server := NewServer()
	server.Register("echo", func(params json.RawMessage) (interface{}, error) {
		var payload struct {
			Value string `json:"value"`
			Delay int    `json:"delay"`
		}
		if err := json.Unmarshal(params, &payload); err != nil {
			return nil, err
		}
		time.Sleep(time.Duration(payload.Delay) * time.Millisecond)
		return payload.Value, nil
	})

	input := strings.NewReader(
		"{\"id\":\"slow\",\"method\":\"echo\",\"params\":{\"value\":\"first\",\"delay\":20}}\n" +
			"{\"id\":\"fast\",\"method\":\"echo\",\"params\":{\"value\":\"second\",\"delay\":0}}\n",
	)
	var output bytes.Buffer
	if err := server.RunIO(input, &output); err != nil {
		t.Fatalf("RunIO returned error: %v", err)
	}

	results := make(map[string]string)
	scanner := bufio.NewScanner(&output)
	for scanner.Scan() {
		var response Response
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			t.Fatalf("invalid response: %v", err)
		}
		results[response.ID] = response.Result.(string)
	}

	if results["slow"] != "first" || results["fast"] != "second" {
		t.Fatalf("responses were not correlated: %#v", results)
	}
}

func TestRunIOAcceptsLargeRequests(t *testing.T) {
	server := NewServer()
	server.Register("size", func(params json.RawMessage) (interface{}, error) {
		return len(params), nil
	})

	payload := strings.Repeat("x", 2<<20)
	input := strings.NewReader(
		"{\"id\":\"large\",\"method\":\"size\",\"params\":{\"value\":\"" + payload + "\"}}\n",
	)
	var output bytes.Buffer
	if err := server.RunIO(input, &output); err != nil {
		t.Fatalf("RunIO returned error: %v", err)
	}
	if output.Len() == 0 {
		t.Fatal("expected a response")
	}
}
