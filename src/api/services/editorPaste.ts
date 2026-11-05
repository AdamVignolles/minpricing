/**
 * Puts formatted text in a rich-text editor (Dealabs' Tiptap/ProseMirror
 * description field, #131) the way a person does: select everything,
 * then paste, with `text/html` and `text/plain` on the clipboard event.
 * ProseMirror parses the HTML with the editor's own schema, so only what
 * the editor supports survives (bold, lists, paragraphs).
 *
 * Returns `false` when the editor didn't take it — the visible text
 * differs, or the formatting is gone — so the caller can fall back to the
 * plain text it typed before: a publish never fails over formatting.
 */
export async function pasteHtml(
  page: import("playwright").Page,
  selector: string,
  html: string,
  visibleText: string,
): Promise<boolean> {
  try {
    const editor = page.locator(selector).first();
    if ((await editor.count()) === 0) return false;
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.evaluate(
      ({ selector, html, text }) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return;
        element.focus();
        const data = new DataTransfer();
        data.setData("text/html", html);
        data.setData("text/plain", text);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { selector, html, text: visibleText },
    );
    await page.waitForTimeout(300);
    const result = await editor.evaluate((element) => ({
      text: element.textContent ?? "",
      bold: element.querySelectorAll("strong, b").length,
      items: element.querySelectorAll("li").length,
    }));
    const compact = (text: string) => text.replace(/\s+/g, "").toLowerCase();
    if (compact(result.text) !== compact(visibleText)) return false;
    if (/<strong>/.test(html) && result.bold === 0) return false;
    if (/<li>/.test(html) && result.items === 0) return false;
    return true;
  } catch {
    return false;
  }
}
