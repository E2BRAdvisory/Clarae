package importer

import (
	"fmt"
	"strings"
)

const reportName = "Import report"

// writeReportNote stores the report as a Markdown note inside the import folder.
func (r *run) writeReportNote() {
	dest, err := r.sink.Reserve(joinPath(r.target, reportName+".md"))
	if err != nil {
		r.warn("report note: %v", err)
		return
	}
	r.rep.ReportPath = dest
	body := renderReport(r.rep)
	if err := r.sink.Write(dest, buildNote([]Prop{{Key: "tags", Value: []string{"import-report"}}}, body)); err != nil {
		r.rep.ReportPath = ""
		r.warn("report note: %v", err)
	}
}

func cell(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "|", "\\|"), "\n", " ")
	return strings.ReplaceAll(s, "[[", "[ [")
}

func renderReport(rep Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Import report\n\n")
	fmt.Fprintf(&b, "- Source: %s\n- Folder: %s\n- Started: %s\n- Finished: %s\n", rep.SourceID, rep.Folder, rep.StartedAt, rep.FinishedAt)
	if rep.Cancelled {
		b.WriteString("- **Cancelled**: the import was stopped before the end\n")
	}
	fmt.Fprintf(&b, "\n## Summary\n\n- Notes created: %d\n- Attachments created: %d\n- Skipped: %d\n- Failed: %d\n- Links rewritten: %d\n- Links left unresolved: %d\n",
		rep.NotesCreated, rep.AttachmentsCreated, len(rep.Skipped), len(rep.Failed), rep.LinksRewritten, rep.LinksUnresolved)
	if len(rep.Warnings) > 0 {
		b.WriteString("\n## Warnings\n\n")
		for _, w := range rep.Warnings {
			b.WriteString("- " + strings.ReplaceAll(w, "\n", " ") + "\n")
		}
	}
	issues := func(title string, items []Item) {
		if len(items) == 0 {
			return
		}
		fmt.Fprintf(&b, "\n## %s\n\n| Kind | Source | Reason |\n| --- | --- | --- |\n", title)
		for _, it := range items {
			fmt.Fprintf(&b, "| %s | %s | %s |\n", it.Kind, cell(it.Source), cell(it.Reason))
		}
	}
	issues("Failed", rep.Failed)
	issues("Skipped", rep.Skipped)
	if len(rep.Created) > 0 {
		b.WriteString("\n## Created\n\n| Kind | Source | Destination |\n| --- | --- | --- |\n")
		for _, it := range rep.Created {
			fmt.Fprintf(&b, "| %s | %s | %s |\n", it.Kind, cell(it.Source), cell(it.Dest))
		}
		if rep.CreatedTruncated {
			fmt.Fprintf(&b, "\nThe list is truncated to the first %d files.\n", maxCreatedItems)
		}
	}
	return b.String()
}
