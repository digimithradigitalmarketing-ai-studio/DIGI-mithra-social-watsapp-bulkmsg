import { renderPositional, toPositional } from '@socialpilot/shared';

export interface StoredTemplate {
  name: string;
  language: string;
  category: string;
  components: Array<{ type: string; format?: string; text?: string; example?: unknown }>;
  variable_mapping: Record<string, string>;
}

/** Build Meta components (positional placeholders + examples) from the editor input. */
export function buildComponents(input: { headerText?: string; body: string; footerText?: string; examples: Record<string, string> }) {
  const { text, mapping } = toPositional(input.body);
  const components: StoredTemplate['components'] = [];
  if (input.headerText) components.push({ type: 'HEADER', format: 'TEXT', text: input.headerText });
  const exampleValues = Object.values(mapping).map((k) => input.examples[k] ?? '');
  components.push(exampleValues.length ? { type: 'BODY', text, example: { body_text: [exampleValues] } } : { type: 'BODY', text });
  if (input.footerText) components.push({ type: 'FOOTER', text: input.footerText });
  return { components, mapping };
}

export function bodyComponent(t: Pick<StoredTemplate, 'components'>) {
  return t.components.find((c) => c.type === 'BODY');
}

/** Turn positional body back into named placeholders for display/editing. */
export function namedBody(t: Pick<StoredTemplate, 'components' | 'variable_mapping'>): string {
  const body = bodyComponent(t)?.text ?? '';
  return body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => (t.variable_mapping[n] ? `{{${t.variable_mapping[n]}}}` : `{{${n}}}`));
}

export function variablesOf(t: Pick<StoredTemplate, 'variable_mapping'>): string[] {
  return Object.keys(t.variable_mapping)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => t.variable_mapping[k]!);
}

export interface VariableContext {
  contact: { name: string; phone_e164: string; custom_fields: Record<string, unknown> };
  businessName: string;
  defaults: Record<string, string>;
}

/** Resolve one variable for a recipient. Contact data wins; campaign defaults are the fallback. */
export function resolveVariable(key: string, ctx: VariableContext): string | null {
  let v: unknown;
  if (key === 'customer_name') v = ctx.contact.name;
  else if (key === 'business_name') v = ctx.businessName;
  else if (key === 'customer_phone') v = ctx.contact.phone_e164;
  else v = ctx.contact.custom_fields?.[key];
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  if (s) return s;
  const d = ctx.defaults[key]?.trim();
  return d ? d : null;
}

/** Values in positional order, or the list of missing variable keys. */
export function resolveAll(t: Pick<StoredTemplate, 'variable_mapping'>, ctx: VariableContext): { values: string[]; missing: string[] } {
  const values: string[] = [];
  const missing: string[] = [];
  for (const key of variablesOf(t)) {
    const v = resolveVariable(key, ctx);
    if (v === null) missing.push(key);
    // Meta rejects newlines/tabs and >4 consecutive spaces in parameters.
    values.push((v ?? '').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   '));
  }
  return { values, missing };
}

export function renderBody(t: Pick<StoredTemplate, 'components'>, values: string[]): string {
  return renderPositional(bodyComponent(t)?.text ?? '', values);
}

