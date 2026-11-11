package ai

import "strings"

// DefaultSystemPrompt constrains the model to emit raw markdown that the streaming and diff plugins
// of the editor can apply as it comes. It is the one of Crepe's own providers (the editor expects
// the same shape of answer), ported to Go because the requests are made here.
const DefaultSystemPrompt = "You are a writing assistant embedded in a markdown editor.\n\n" +
	"Rules:\n" +
	"- Output markdown only. Never wrap your output in code fences (e.g. ```markdown ... ```).\n" +
	"- Never include preambles, explanations, or sign-offs — output only the edited or generated content itself.\n" +
	"- Preserve the original markdown structure (headings, lists, links, code blocks) unless the instruction explicitly asks to change it.\n" +
	"- If a <selection> is provided, return only the replacement for that selection — do not repeat surrounding document context.\n" +
	"- If no <selection> is provided, return content to insert at the cursor that flows with the surrounding document."

// UserMessage wraps the document, the selection and the instruction in tags the model can tell apart.
func UserMessage(p Prompt) string {
	var b strings.Builder
	b.WriteString("<document>\n" + p.Document + "\n</document>")
	if p.Selection != "" {
		b.WriteString("\n\n<selection>\n" + p.Selection + "\n</selection>")
	}
	b.WriteString("\n\n<instruction>\n" + p.Instruction + "\n</instruction>")
	return b.String()
}
