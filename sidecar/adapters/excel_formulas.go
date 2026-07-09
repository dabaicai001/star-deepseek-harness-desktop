package adapters

import (
	"archive/zip"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"strings"
)

type workbookSheetRef struct {
	Name  string `xml:"name,attr"`
	RelID string `xml:"id,attr"`
}

type workbookSheetList struct {
	Sheets []workbookSheetRef `xml:"sheets>sheet"`
}

type workbookRelationship struct {
	ID     string `xml:"Id,attr"`
	Target string `xml:"Target,attr"`
}

type workbookRelationships struct {
	Relationships []workbookRelationship `xml:"Relationship"`
}

type indexedFormula struct {
	Content string `xml:",chardata"`
}

type indexedFormulaCell struct {
	Axis    string          `xml:"r,attr"`
	Formula *indexedFormula `xml:"f"`
}

// readExcelFormulaIndex scans worksheet XML once and records only cells that
// actually contain formulas. This turns ReadSheet formula preservation from a
// rows*columns random-access scan into an O(formula cells) overlay.
func readExcelFormulaIndex(filePath string) (map[string]map[string]string, error) {
	index := make(map[string]map[string]string)
	reader, err := zip.OpenReader(filePath)
	if err != nil {
		return index, fmt.Errorf("open xlsx formula index: %w", err)
	}
	defer reader.Close()

	files := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		files[path.Clean(strings.TrimPrefix(file.Name, "/"))] = file
	}

	var workbook workbookSheetList
	if err := decodeZipXML(files["xl/workbook.xml"], &workbook); err != nil {
		return index, fmt.Errorf("decode workbook sheets: %w", err)
	}
	var relationships workbookRelationships
	if err := decodeZipXML(files["xl/_rels/workbook.xml.rels"], &relationships); err != nil {
		return index, fmt.Errorf("decode workbook relationships: %w", err)
	}
	targetByID := make(map[string]string, len(relationships.Relationships))
	for _, relationship := range relationships.Relationships {
		target := strings.TrimPrefix(relationship.Target, "/")
		if !strings.HasPrefix(target, "xl/") {
			target = path.Join("xl", target)
		}
		targetByID[relationship.ID] = path.Clean(target)
	}

	for _, sheet := range workbook.Sheets {
		worksheet := files[targetByID[sheet.RelID]]
		if worksheet == nil {
			return index, fmt.Errorf("worksheet XML missing for %q", sheet.Name)
		}
		formulas, scanErr := scanWorksheetFormulas(worksheet)
		if scanErr != nil {
			return index, fmt.Errorf("scan formulas in %q: %w", sheet.Name, scanErr)
		}
		index[sheet.Name] = formulas
	}
	return index, nil
}

func decodeZipXML(file *zip.File, target any) error {
	if file == nil {
		return fmt.Errorf("required XML part is missing")
	}
	stream, err := file.Open()
	if err != nil {
		return err
	}
	defer stream.Close()
	return xml.NewDecoder(stream).Decode(target)
}

func scanWorksheetFormulas(file *zip.File) (map[string]string, error) {
	formulas := make(map[string]string)
	stream, err := file.Open()
	if err != nil {
		return formulas, err
	}
	defer stream.Close()

	decoder := xml.NewDecoder(stream)
	for {
		token, tokenErr := decoder.Token()
		if tokenErr == io.EOF {
			return formulas, nil
		}
		if tokenErr != nil {
			return formulas, tokenErr
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "c" {
			continue
		}
		var cell indexedFormulaCell
		if err := decoder.DecodeElement(&cell, &start); err != nil {
			return formulas, err
		}
		if cell.Axis != "" && cell.Formula != nil {
			formulas[cell.Axis] = strings.TrimSpace(cell.Formula.Content)
		}
	}
}

func (a *ExcelAdapter) setIndexedFormula(sheetName, axis, formula string) {
	if a.formulaCells == nil {
		a.formulaCells = make(map[string]map[string]string)
	}
	if a.formulaCells[sheetName] == nil {
		a.formulaCells[sheetName] = make(map[string]string)
	}
	a.formulaCells[sheetName][axis] = formula
	a.formulaIndexReady = true
}

func (a *ExcelAdapter) deleteIndexedFormula(sheetName, axis string) {
	delete(a.formulaCells[sheetName], axis)
}
