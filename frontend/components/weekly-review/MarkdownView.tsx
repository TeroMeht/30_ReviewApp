import React from "react";

/**
 * Dependency-free, deliberately small markdown renderer. Handles the
 * subset Claude emits for reviews: ATX headings (#..####), unordered
 * (-, *) and ordered (1.) lists, blockquotes, horizontal rules, blank-line
 * separated paragraphs, and inline **bold** / *italic* / `code`.
 *
 * This is not a full CommonMark implementation — it covers the review
 * format and degrades gracefully (anything unrecognised renders as text).
 */
export default function MarkdownView({ markdown }: { markdown: string }) {
  return <div className="review-md max-w-3xl">{renderBlocks(markdown)}</div>;
}

function renderBlocks(md: string): React.ReactNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push(<hr key={key++} className="my-6 border-gray-200" />);
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(heading(level, h[2], key++));
      i++;
      continue;
    }

    // List (collect consecutive items)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const cls = "my-3 ml-6 space-y-1 " + (ordered ? "list-decimal" : "list-disc");
      out.push(
        ordered ? (
          <ol key={key++} className={cls}>
            {items.map((it, j) => (
              <li key={j} className="text-gray-700">{renderInline(it)}</li>
            ))}
          </ol>
        ) : (
          <ul key={key++} className={cls}>
            {items.map((it, j) => (
              <li key={j} className="text-gray-700">{renderInline(it)}</li>
            ))}
          </ul>
        )
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(
        <blockquote
          key={key++}
          className="my-3 border-l-4 border-gray-300 pl-4 text-gray-600 italic"
        >
          {renderInline(quote.join(" "))}
        </blockquote>
      );
      continue;
    }

    // Paragraph (gather until blank line)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} className="my-3 leading-relaxed text-gray-700">
        {renderInline(para.join(" "))}
      </p>
    );
  }

  return out;
}

function heading(level: number, text: string, key: number): React.ReactNode {
  const content = renderInline(text);
  switch (level) {
    case 1:
      return <h1 key={key} className="mt-6 mb-3 text-2xl font-bold text-gray-900">{content}</h1>;
    case 2:
      return <h2 key={key} className="mt-6 mb-2 text-xl font-semibold text-gray-900 border-b border-gray-200 pb-1">{content}</h2>;
    case 3:
      return <h3 key={key} className="mt-4 mb-2 text-lg font-semibold text-gray-800">{content}</h3>;
    default:
      return <h4 key={key} className="mt-3 mb-1 text-base font-semibold text-gray-800">{content}</h4>;
  }
}

/** Inline: **bold**, *italic* / _italic_, `code`. */
function renderInline(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  // Split on the inline markers, keeping the delimiters.
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push(text.slice(lastIndex, m.index));
    }
    const tok = m[0];
    if (tok.startsWith("**")) {
      tokens.push(<strong key={k++} className="font-semibold text-gray-900">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      tokens.push(<code key={k++} className="rounded bg-gray-100 px-1 py-0.5 text-sm font-mono">{tok.slice(1, -1)}</code>);
    } else {
      tokens.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}
