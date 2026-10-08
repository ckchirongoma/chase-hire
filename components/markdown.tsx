import { parseMarkdown, type Inline } from "@/lib/markdown";

function Text({ inline }: { inline: Inline }) {
  return inline.map((r, i) => (r.bold ? <strong key={i}>{r.text}</strong> : <span key={i}>{r.text}</span>));
}

/** Renders the small markdown subset in lib/markdown.ts. Text only: no HTML is ever injected. */
export default function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return (
    <div className={`space-y-3 text-slate-700 ${className}`}>
      {parseMarkdown(source).map((b, i) => {
        switch (b.type) {
          case "h2":
            return <h2 key={i} className="h2 pt-3 text-slate-900"><Text inline={b.inline} /></h2>;
          case "h3":
            return <h3 key={i} className="pt-1 font-semibold text-slate-900"><Text inline={b.inline} /></h3>;
          case "p":
            return <p key={i}><Text inline={b.inline} /></p>;
          case "ul":
          case "ol": {
            const List = b.type;
            return (
              <List key={i} className={`space-y-1.5 pl-5 ${b.type === "ul" ? "list-disc" : "list-decimal"}`}>
                {b.items.map((item, j) => <li key={j}><Text inline={item} /></li>)}
              </List>
            );
          }
        }
      })}
    </div>
  );
}
