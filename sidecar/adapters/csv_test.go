package adapters

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCsvAdapterReadsVariableRowsAndExposesSheetData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.csv")
	if err := os.WriteFile(path, []byte("name,score\nalice\nbob,10,extra\n"), 0o600); err != nil {
		t.Fatalf("write csv failed: %v", err)
	}

	adapter, err := NewCsvAdapter(&CsvConnInfo{FilePath: path})
	if err != nil {
		t.Fatalf("NewCsvAdapter failed: %v", err)
	}

	data, err := adapter.ReadSheet(csvSheetName, 0, 0)
	if err != nil {
		t.Fatalf("ReadSheet failed: %v", err)
	}
	if data.SheetName != csvSheetName {
		t.Fatalf("sheet name mismatch: %q", data.SheetName)
	}
	if len(data.Columns) != 3 {
		t.Fatalf("expected max-width columns, got %#v", data.Columns)
	}
	if len(data.Rows) != 2 || len(data.Rows[0]) != 3 || data.Rows[0][1] != "" {
		t.Fatalf("rows were not normalized: %#v", data.Rows)
	}
}

func TestCsvAdapterEditsAndSavesDataRowsBelowHeader(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.csv")
	if err := os.WriteFile(path, []byte("name,score\nalice,9\n"), 0o600); err != nil {
		t.Fatalf("write csv failed: %v", err)
	}

	adapter, err := NewCsvAdapter(&CsvConnInfo{FilePath: path})
	if err != nil {
		t.Fatalf("NewCsvAdapter failed: %v", err)
	}
	if err := adapter.WriteCells([]CellChange{{Row: 0, Col: 1, Value: "10"}}); err != nil {
		t.Fatalf("WriteCells failed: %v", err)
	}
	if err := adapter.Save(); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	reopened, err := NewCsvAdapter(&CsvConnInfo{FilePath: path})
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	data, err := reopened.ReadSheet(csvSheetName, 0, 0)
	if err != nil {
		t.Fatalf("ReadSheet failed: %v", err)
	}
	if data.Columns[1] != "score" {
		t.Fatalf("header overwritten: %#v", data.Columns)
	}
	if data.Rows[0][1] != "10" {
		t.Fatalf("data cell mismatch: %#v", data.Rows)
	}
}

func TestCsvAdapterSheetLikeOperations(t *testing.T) {
	adapter := &CsvAdapter{
		rows: [][]string{
			{"name", "score"},
			{"bob", "2"},
			{"alice", "10"},
			{"bob", "2"},
		},
		delimiter: ',',
	}
	adapter.syncColumns()

	if err := adapter.InsertRows(1, 1); err != nil {
		t.Fatalf("InsertRows failed: %v", err)
	}
	if len(adapter.rows) != 5 || adapter.rows[2][0] != "" {
		t.Fatalf("insert row mismatch: %#v", adapter.rows)
	}
	if err := adapter.DeleteRows(1, 1); err != nil {
		t.Fatalf("DeleteRows failed: %v", err)
	}
	if err := adapter.InsertCols(1, 1); err != nil {
		t.Fatalf("InsertCols failed: %v", err)
	}
	if adapter.rows[0][2] != "score" {
		t.Fatalf("insert col mismatch: %#v", adapter.rows)
	}
	if err := adapter.DeleteCols(1, 1); err != nil {
		t.Fatalf("DeleteCols failed: %v", err)
	}
	if err := adapter.SortRows(1, true); err != nil {
		t.Fatalf("SortRows failed: %v", err)
	}
	if adapter.rows[1][0] != "alice" {
		t.Fatalf("sort mismatch: %#v", adapter.rows)
	}
	replaced, err := adapter.FindReplace(FindReplaceOptions{Find: "alice", Replace: "ALICE", MatchCase: true})
	if err != nil {
		t.Fatalf("FindReplace failed: %v", err)
	}
	if replaced != 1 || adapter.rows[1][0] != "ALICE" {
		t.Fatalf("replace mismatch: replaced=%d rows=%#v", replaced, adapter.rows)
	}
	removed, err := adapter.RemoveDuplicates(nil)
	if err != nil {
		t.Fatalf("RemoveDuplicates failed: %v", err)
	}
	if removed != 1 || len(adapter.rows) != 3 {
		t.Fatalf("dedup mismatch: removed=%d rows=%#v", removed, adapter.rows)
	}
}
