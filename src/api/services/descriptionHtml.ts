/**
 * Turns a Dealabs description written as plain text (what the renderer
 * produces, or what the owner or an agent typed) into the HTML put in
 * Dealabs' rich editor (#131) and shown in the console's preview — one
 * function for both, so the preview is what gets posted.
 *
 * The plain format:
 * - a blank line separates blocks;
 * - « - », « • » or « * » starts a list item;
 * - a short line ending with « : » right before a list is a bold label;
 * - « **texte** » is bold;
 * - any other line is a paragraph (consecutive lines joined by a break).
 *
 * Only `p`, `strong`, `ul`, `li` and `br` come out, all text escaped: the
 * editor's own working set (audit F17 §1), nothing it could refuse.
 */

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Escapes, then « **gras** » → `<strong>`. */
function inline(text: string): string {
  return escape(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const ITEM = /^\s*[-•*]\s+(.*)$/;
const LABEL_MAX = 60;

export function descriptionHtml(text: string): string {
  const out: string[] = [];
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((line) => line.trimEnd()))
    .map((lines) => lines.filter((line) => line.trim() !== ""))
    .filter((lines) => lines.length > 0);
  for (const lines of blocks) {
    let paragraph: string[] = [];
    let items: string[] = [];
    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    };
    const flushItems = () => {
      if (items.length) {
        out.push(
          `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`,
        );
      }
      items = [];
    };
    for (const [index, line] of lines.entries()) {
      const item = ITEM.exec(line);
      if (item && !line.trim().startsWith("**")) {
        flushParagraph();
        items.push(inline(item[1].trim()));
        continue;
      }
      flushItems();
      const next = lines[index + 1];
      const trimmed = line.trim();
      if (
        trimmed.endsWith(":") &&
        trimmed.length <= LABEL_MAX &&
        next !== undefined &&
        ITEM.test(next)
      ) {
        flushParagraph();
        const label = trimmed.replace(/^\*\*(.+)\*\*$/, "$1");
        out.push(`<p><strong>${inline(label)}</strong></p>`);
        continue;
      }
      paragraph.push(inline(trimmed));
    }
    flushParagraph();
    flushItems();
  }
  return out.join("");
}

/** The text a reader sees in that HTML, for checking the editor took it. */
export function descriptionVisibleText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(ITEM, "$1").replace(/\*\*(.+?)\*\*/g, "$1"))
    .join("\n");
}
