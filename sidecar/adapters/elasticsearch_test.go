package adapters

import "testing"

func TestBuildElasticsearchAddressFromURL(t *testing.T) {
	info := &ElasticsearchConnInfo{Address: "https://es.internal:9243"}

	addr, err := buildElasticsearchAddress(info)

	if err != nil {
		t.Fatalf("buildElasticsearchAddress returned error: %v", err)
	}
	if addr != "https://es.internal:9243" {
		t.Fatalf("addr = %q, want %q", addr, "https://es.internal:9243")
	}
	if info.Host != "es.internal" || info.Port != 9243 || !info.UseSSL {
		t.Fatalf("parsed info = host:%q port:%d ssl:%v", info.Host, info.Port, info.UseSSL)
	}
}

func TestBuildElasticsearchAddressAddsDefaultScheme(t *testing.T) {
	info := &ElasticsearchConnInfo{Address: "127.0.0.1:9201"}

	addr, err := buildElasticsearchAddress(info)

	if err != nil {
		t.Fatalf("buildElasticsearchAddress returned error: %v", err)
	}
	if addr != "http://127.0.0.1:9201" {
		t.Fatalf("addr = %q, want %q", addr, "http://127.0.0.1:9201")
	}
	if info.Host != "127.0.0.1" || info.Port != 9201 || info.UseSSL {
		t.Fatalf("parsed info = host:%q port:%d ssl:%v", info.Host, info.Port, info.UseSSL)
	}
}
