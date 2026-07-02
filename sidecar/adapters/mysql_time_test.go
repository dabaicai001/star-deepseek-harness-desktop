package adapters

import (
	"testing"
	"time"
)

func TestFormatMySQLTimeValue(t *testing.T) {
	value := time.Date(2026, 7, 2, 10, 20, 30, 123456000, time.UTC)

	cases := []struct {
		name     string
		dbType   string
		expected string
	}{
		{name: "date", dbType: "DATE", expected: "2026-07-02"},
		{name: "datetime", dbType: "DATETIME", expected: "2026-07-02 10:20:30.123456"},
		{name: "timestamp", dbType: "TIMESTAMP", expected: "2026-07-02 10:20:30.123456"},
		{name: "time", dbType: "TIME", expected: "10:20:30.123456"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatMySQLTimeValue(value, tc.dbType); got != tc.expected {
				t.Fatalf("formatMySQLTimeValue() = %q, want %q", got, tc.expected)
			}
		})
	}
}

func TestNormalizeMySQLInputValueTemporalStrings(t *testing.T) {
	cases := []struct {
		name     string
		value    interface{}
		dataType string
		expected interface{}
	}{
		{
			name:     "rfc3339 datetime",
			value:    "2026-07-02T10:20:30Z",
			dataType: "datetime",
			expected: "2026-07-02 10:20:30",
		},
		{
			name:     "rfc3339 timestamp with fraction",
			value:    "2026-07-02T10:20:30.120Z",
			dataType: "timestamp",
			expected: "2026-07-02 10:20:30.12",
		},
		{
			name:     "rfc3339 date",
			value:    "2026-07-02T10:20:30Z",
			dataType: "date",
			expected: "2026-07-02",
		},
		{
			name:     "rfc3339 time",
			value:    "2026-07-02T10:20:30Z",
			dataType: "time",
			expected: "10:20:30",
		},
		{
			name:     "mysql datetime unchanged",
			value:    "2026-07-02 10:20:30",
			dataType: "datetime",
			expected: "2026-07-02 10:20:30",
		},
		{
			name:     "null marker",
			value:    "NULL",
			dataType: "datetime",
			expected: nil,
		},
		{
			name:     "non temporal unchanged",
			value:    "2026-07-02T10:20:30Z",
			dataType: "varchar",
			expected: "2026-07-02T10:20:30Z",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeMySQLInputValue(tc.value, tc.dataType); got != tc.expected {
				t.Fatalf("normalizeMySQLInputValue() = %#v, want %#v", got, tc.expected)
			}
		})
	}
}
