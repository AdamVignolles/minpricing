import {
  Anchor,
  Blockquote,
  Code,
  List,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { Fragment, type FC, type ReactNode } from "react";

/**
 * Renders the agents' reports: the small Markdown subset they write
 * (headings, paragraphs, quotes, lists, tables, **bold**, `code`, links)
 * plus the two Notion tags the evening report keeps (`<callout>`, `<b>`).
 * Text only — no HTML is ever injected, so a report can't run anything.
 */

const inline = (text: string): ReactNode[] => {
  const parts: ReactNode[] = [];
  const pattern =
    /\*\*(.+?)\*\*|<b>(.+?)<\/b>|`([^`]+)`|<code>(.+?)<\/code>|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const [, bold, b, code, codeTag, label, href] = match;
    if (bold ?? b) parts.push(<strong key={key++}>{bold ?? b}</strong>);
    else if (code ?? codeTag)
      parts.push(<Code key={key++}>{code ?? codeTag}</Code>);
    else if (label && href)
      parts.push(
        <Anchor key={key++} href={href} target="_blank" rel="noreferrer">
          {label}
        </Anchor>,
      );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((part, i) =>
    typeof part === "string" ? (
      part.replace(/<[^>]+>/g, "")
    ) : (
      <Fragment key={`p${i}`}>{part}</Fragment>
    ),
  );
};

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

const Markdown: FC<{ source: string }> = ({ source }) => {
  const lines = source.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("<callout")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("</callout>"))
        body.push(lines[i++]);
      i++;
      blocks.push(
        <Paper
          key={key++}
          p="md"
          withBorder
          style={{ borderLeft: "3px solid var(--mantine-color-blue-6)" }}
        >
          <Text fz="sm">{inline(body.join(" "))}</Text>
        </Paper>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.+)$/);
    if (heading) {
      const order = Math.min(heading[1].length + 1, 4) as 2 | 3 | 4;
      blocks.push(
        <Title
          key={key++}
          order={order}
          fz={order === 2 ? "xl" : order === 3 ? "lg" : "md"}
          mt={order === 2 ? 0 : "sm"}
        >
          {inline(heading[2])}
        </Title>,
      );
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith("> "))
        quote.push(lines[i++].slice(2));
      blocks.push(
        <Blockquote key={key++} color="blue" p="sm">
          <Text fz="sm">{inline(quote.join(" "))}</Text>
        </Blockquote>,
      );
      continue;
    }
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|"))
        tableLines.push(lines[i++]);
      const [head, , ...body] = tableLines;
      blocks.push(
        <ScrollArea key={key++} type="auto">
          <Table striped withTableBorder fz="sm" miw={480}>
            <Table.Thead>
              <Table.Tr>
                {cells(head).map((cell, c) => (
                  <Table.Th key={c}>{inline(cell)}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {body.map((row, r) => (
                <Table.Tr key={r}>
                  {cells(row).map((cell, c) => (
                    <Table.Td key={c}>{inline(cell)}</Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea>,
      );
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        if (/^\s*[-*] /.test(lines[i]))
          items.push(lines[i++].replace(/^\s*[-*] /, ""));
        // an indented line continues the previous item (wrapped text)
        else if (items.length && /^\s+\S/.test(lines[i]))
          items[items.length - 1] += ` ${lines[i++].trim()}`;
        else break;
      }
      blocks.push(
        <List key={key++} fz="sm" spacing={4}>
          {items.map((item, n) => (
            <List.Item key={n}>{inline(item)}</List.Item>
          ))}
        </List>,
      );
      continue;
    }
    if (line.startsWith("<!--")) {
      i++;
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3} |> |\||\s*[-*] |<callout)/.test(lines[i])
    )
      paragraph.push(lines[i++]);
    blocks.push(
      <Text key={key++} fz="sm">
        {inline(paragraph.join(" "))}
      </Text>,
    );
  }
  return <Stack gap="sm">{blocks}</Stack>;
};

export default Markdown;
