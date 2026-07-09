package adapters

import (
	"strings"
	"testing"
)

// 表列表查询不能把数据库允许为 NULL 的统计字段扫描进 Go 标量。
func TestRelationalTableMetadataCoalescesNullableFields(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  []string
	}{
		{
			name:  "mysql",
			query: mysqlListTablesQuery,
			want:  []string{"coalesce(table_rows, 0)", "coalesce(engine, '')", "coalesce(table_comment, '')"},
		},
		{
			name:  "clickhouse",
			query: clickHouseListTablesQuery,
			want:  []string{"coalesce(total_rows, 0)", "coalesce(comment, '')"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			query := strings.ToLower(test.query)
			for _, fragment := range test.want {
				if !strings.Contains(query, fragment) {
					t.Fatalf("metadata query must contain %q:\n%s", fragment, test.query)
				}
			}
		})
	}
}

func TestPostgresMetadataDefaultsAndEscaping(t *testing.T) {
	if got := postgresSchema(""); got != "public" {
		t.Fatalf("default schema = %q, want public", got)
	}
	if got := quotePostgresIdentifier(`a"b`); got != `"a""b"` {
		t.Fatalf("quoted identifier = %q", got)
	}
}
