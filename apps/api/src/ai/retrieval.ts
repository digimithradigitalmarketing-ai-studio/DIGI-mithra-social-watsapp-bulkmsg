/**
 * Lightweight lexical retrieval over the tenant's knowledge base (FAQ entries and text documents).
 * No embeddings and no third-party calls: knowledge never leaves the database except inside the
 * final prompt to the configured model. Works for English and Kannada (Unicode letters/digits).
 */
import type { Queryable } from '../db';

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'do', 'does', 'did', 'you', 'your', 'we', 'our', 'i', 'me', 'my', 'it', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or',
  'what', 'when', 'where', 'how', 'can', 'could', 'there', 'any', 'have', 'has', 'be', 'with', 'this', 'that', 'please', 'hi', 'hello', 'hey', 'u', 'pls',
  'tell', 'about', 'want', 'know', 'from', 'will', 'would', 'should', 'much', 'many', 'which', 'who', 'yes', 'no', 'ok',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
    .filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)); // naive plural folding
}

export interface RankedChunk { id: string; title: string; kind: 'faq' | 'text'; text: string; answerText?: string; score: number }

interface SourceRow { id: string; source_type: 'faq' | 'text'; title: string; question: string | null; answer: string | null; content: string | null }

function chunks(row: SourceRow): Array<Omit<RankedChunk, 'score'> & { matchText: string }> {
  if (row.source_type === 'faq') {
    const text = `Q: ${row.question}\nA: ${row.answer}`;
    // Question words count double: they describe what the entry is about.
    return [{ id: row.id, title: row.question ?? row.title, kind: 'faq', text, answerText: row.answer ?? '', matchText: `${row.question} ${row.question} ${row.answer}` }];
  }
  const content = row.content ?? '';
  const paras = content.split(/\n\s*\n/).flatMap((p) => (p.length > 900 ? p.match(/[\s\S]{1,800}(?:\s|$)/g) ?? [p] : [p])).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => ({ id: row.id, title: row.title, kind: 'text' as const, text: p, matchText: `${row.title} ${p}` }));
}

/** Rank knowledge chunks for a question using a BM25-style score. */
export async function retrieve(db: Queryable, businessId: string, question: string, limit = 5): Promise<RankedChunk[]> {
  const rows = await db.query<SourceRow>(
    `select id, source_type, title, question, answer, content from public.ai_knowledge_sources where business_id = $1 and status = 'active' limit 2000`,
    [businessId],
  );
  const all = rows.rows.flatMap(chunks);
  if (!all.length) return [];
  const q = [...new Set(tokenize(question))];
  if (!q.length) return [];
  const docs = all.map((c) => tokenize(c.matchText));
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const N = docs.length;
  const scored = all.map((c, i) => {
    const d = docs[i]!;
    let score = 0;
    for (const t of q) {
      const tf = d.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.length / avgLen))));
    }
    // Scale so that one strong distinct keyword ≈ 2 points regardless of corpus size.
    return { id: c.id, title: c.title, kind: c.kind, text: c.text, answerText: c.answerText, score: Math.round(score * 1.6 * 100) / 100 };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
