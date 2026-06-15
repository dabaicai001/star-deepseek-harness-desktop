package adapters

import "testing"

func TestQuoteIdentifierEscapesBackticks(t *testing.T) {
	got := quoteIdentifier("users`archive")
	want := "`users``archive`"
	if got != want {
		t.Fatalf("quoteIdentifier() = %q, want %q", got, want)
	}
}

func TestQualifiedIdentifierQuotesEveryPart(t *testing.T) {
	got := qualifiedIdentifier("app`db", "user data")
	want := "`app``db`.`user data`"
	if got != want {
		t.Fatalf("qualifiedIdentifier() = %q, want %q", got, want)
	}
}
