package adapters

import (
	"testing"

	"github.com/starhub/sidecar/pool"
	"github.com/starhub/sidecar/rpc"
)

type methodCollector map[string]rpc.Handler

func (collector methodCollector) Register(method string, handler rpc.Handler) {
	collector[method] = handler
}

func TestRegisterDBHandlersIncludesTableMetadataMethods(t *testing.T) {
	collector := methodCollector{}
	RegisterDBHandlers(collector, pool.NewManager())

	required := []string{
		"db.mysql.getTableMeta",
		"db.mysql.getTableData",
		"db.postgres.connect",
		"db.postgres.test",
		"db.clickhouse.getTableMeta",
		"db.clickhouse.getTableData",
		"broker.kafka.test",
		"broker.kafka.overview",
		"broker.nsq.test",
		"broker.nsq.overview",
	}
	for _, method := range required {
		if _, ok := collector[method]; !ok {
			t.Errorf("required RPC method %q was not registered", method)
		}
	}
}
