package adapters

import "strings"

func quoteIdentifier(identifier string) string {
	return "`" + strings.ReplaceAll(identifier, "`", "``") + "`"
}

func qualifiedIdentifier(parts ...string) string {
	quoted := make([]string, len(parts))
	for index, part := range parts {
		quoted[index] = quoteIdentifier(part)
	}
	return strings.Join(quoted, ".")
}
