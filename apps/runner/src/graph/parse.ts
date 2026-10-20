import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language as TsLanguage, Node as TsNode, Parser as TsParser } from '@vscode/tree-sitter-wasm';
import type { Lang } from './discover.ts';
import { scanMarkdown } from './docs.ts';
import { sanitizeLabel } from './sanitize.ts';
import type { CallFact, FileFacts, ImportFact, SymbolFact, SymbolSub } from './types.ts';

/** The pinned parser (tree-sitter through `@vscode/tree-sitter-wasm`) and its grammars: part of the cache fingerprint. */
export const PARSER_PACKAGE = '@vscode/tree-sitter-wasm@0.3.1';
/** Bumped when an extractor changes what it produces from the same file: invalidates every cached fact. */
export const EXTRACTOR_VERSION = 3;
/** Never more than this many symbols, imports or calls from one file (a generated file must not flood the graph). */
const CAP = { symbols: 3000, imports: 1000, calls: 8000 };

const nodeRequire = createRequire(import.meta.url);
/** The runtime next to the bundle is a `.cjs` copy (the runner package is `type: module`); the package's own file is CommonJS. */
const RUNTIME_FILE = 'tree-sitter.cjs';
const runtimeFile = (dir: string): string =>
  join(dir, existsSync(join(dir, RUNTIME_FILE)) ? RUNTIME_FILE : 'tree-sitter.js');

/** Where the runtime and the grammars are: next to the bundle (`dist/grammars`, shipped in the tarball), else the package. */
export function grammarDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [
    join(here, 'grammars'),
    join(here, '..', 'grammars'),
    join(here, '..', '..', 'dist', 'grammars'),
  ]) {
    if (existsSync(join(c, RUNTIME_FILE))) return c;
  }
  const pkg = nodeRequire.resolve('@vscode/tree-sitter-wasm/package.json');
  return join(dirname(pkg), 'wasm');
}

export const GRAMMAR_FILES_BY_LANG: Record<Exclude<Lang, 'markdown'>, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  csharp: 'tree-sitter-c-sharp.wasm',
};

interface Runtime {
  parser: TsParser;
  languages: Map<string, TsLanguage>;
  dir: string;
}

let runtime: Promise<Runtime> | null = null;

async function load(): Promise<Runtime> {
  const dir = grammarDir();
  const mod = nodeRequire(runtimeFile(dir)) as {
    Parser: typeof TsParser & { init(o?: unknown): Promise<void> };
    Language: typeof TsLanguage;
  };
  await mod.Parser.init({ locateFile: (f: string) => join(dir, f) });
  return { parser: new mod.Parser(), languages: new Map(), dir };
}

/** The language handle of `lang`, loaded once. */
async function language(rt: Runtime, lang: Exclude<Lang, 'markdown'>): Promise<TsLanguage> {
  const have = rt.languages.get(lang);
  if (have) return have;
  const mod = nodeRequire(runtimeFile(rt.dir)) as { Language: typeof TsLanguage };
  const l = await mod.Language.load(readFileSync(join(rt.dir, GRAMMAR_FILES_BY_LANG[lang])));
  rt.languages.set(lang, l);
  return l;
}

/** Fingerprint of everything that decides what a parse returns: a changed grammar or extractor invalidates the cache. */
export function parserFingerprint(): string {
  return `${PARSER_PACKAGE}+extractors:${EXTRACTOR_VERSION}`;
}

const text = (n: TsNode | null | undefined): string => (n ? n.text : '');
const field = (n: TsNode, name: string): TsNode | null => n.childForFieldName(name);
const named = (n: TsNode): TsNode[] => n.namedChildren.filter((c): c is TsNode => !!c);

/** The last segment of a dotted, qualified or scoped name (`a.b.C` -> `C`). */
const lastSegment = (s: string): string => {
  const base = s.replace(/<.*$/s, '');
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(base);
  return m?.[1] ?? base;
};

interface Ctx {
  /** Qualified name of the enclosing class/type. */
  cls?: string;
  /** Qualified name of the enclosing emitted symbol (the caller of a call). */
  fn?: string;
  /** Inside a function body: nested declarations are not emitted as symbols. */
  inFn: boolean;
  exported: boolean;
  ns?: string;
}

interface Frame {
  node: TsNode;
  ctx: Ctx;
}

class Sink {
  symbols: SymbolFact[] = [];
  imports: ImportFact[] = [];
  calls: CallFact[] = [];
  namespaces = new Set<string>();
  private seen = new Set<string>();

  symbol(s: SymbolFact): void {
    if (this.symbols.length >= CAP.symbols) return;
    const key = `${s.sub}:${s.qname}`;
    if (this.seen.has(key)) {
      // overloads and merged declarations: keep the first, name later ones by line
      s = { ...s, qname: `${s.qname}~${s.line}` };
    }
    this.seen.add(`${s.sub}:${s.qname}`);
    this.symbols.push({ ...s, name: sanitizeLabel(s.name, 128), qname: sanitizeLabel(s.qname, 200) });
  }
  imp(i: ImportFact): void {
    if (this.imports.length < CAP.imports) this.imports.push(i);
  }
  call(c: CallFact): void {
    if (this.calls.length < CAP.calls) this.calls.push(c);
  }
}

const line = (n: TsNode): number => n.startPosition.row + 1;
const endLine = (n: TsNode): number => n.endPosition.row + 1;
const qual = (cls: string | undefined, name: string): string => (cls ? `${cls}.${name}` : name);

function stringValue(n: TsNode | null): string {
  if (!n) return '';
  const t = n.text;
  return t.replace(/^[`'"]|[`'"]$/g, '');
}

// ------------------------------------------------------------------------------------- TypeScript, TSX, JavaScript

function heritageNames(n: TsNode): string[] {
  const out: string[] = [];
  for (const c of named(n)) {
    if (c.type === 'type_arguments' || c.type === 'type_parameters') continue;
    if (c.type === 'generic_type') out.push(lastSegment(text(field(c, 'name') ?? c.namedChildren[0])));
    else out.push(lastSegment(c.text));
  }
  return out.filter(Boolean);
}

function tsVisit(root: TsNode, sink: Sink): void {
  const stack: Frame[] = [{ node: root, ctx: { inFn: false, exported: false } }];
  const push = (n: TsNode, ctx: Ctx) => stack.push({ node: n, ctx });
  const pushChildren = (n: TsNode, ctx: Ctx) => {
    const kids = named(n);
    for (let i = kids.length - 1; i >= 0; i--) push(kids[i] as TsNode, ctx);
  };
  while (stack.length) {
    const { node: n, ctx } = stack.pop() as Frame;
    switch (n.type) {
      case 'export_statement': {
        const source = field(n, 'source');
        if (source) {
          const names: ImportFact['names'] = [];
          for (const c of named(n)) {
            if (c.type === 'export_clause')
              for (const s of named(c)) {
                const nm = text(field(s, 'name') ?? s.namedChildren[0]);
                const al = text(field(s, 'alias'));
                names.push(al ? { name: nm, alias: al } : { name: nm });
              }
            else if (c.type === 'namespace_export') names.push({ name: '*' });
          }
          if (names.length === 0) names.push({ name: '*' });
          sink.imp({ spec: stringValue(source), names, line: line(n) });
          break;
        }
        pushChildren(n, { ...ctx, exported: true });
        break;
      }
      case 'import_statement': {
        const source = field(n, 'source');
        if (!source) break;
        const names: ImportFact['names'] = [];
        const clause = named(n).find((c) => c.type === 'import_clause');
        if (clause)
          for (const c of named(clause)) {
            if (c.type === 'identifier') names.push({ name: 'default', alias: c.text });
            else if (c.type === 'namespace_import')
              names.push({ name: '*', alias: text(c.namedChildren[0]) });
            else if (c.type === 'named_imports')
              for (const s of named(c)) {
                const nm = text(field(s, 'name') ?? s.namedChildren[0]);
                const al = text(field(s, 'alias'));
                names.push(al ? { name: nm, alias: al } : { name: nm });
              }
          }
        sink.imp({ spec: stringValue(source), names, line: line(n) });
        break;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = text(field(n, 'name'));
        if (!name || ctx.inFn) {
          const body = field(n, 'body');
          if (body) push(body, ctx);
          break;
        }
        const q = qual(ctx.cls, name);
        const ext: string[] = [];
        const impl: string[] = [];
        for (const c of named(n)) {
          if (c.type !== 'class_heritage') continue;
          for (const h of named(c)) {
            if (h.type === 'extends_clause') ext.push(...heritageNames(h));
            else if (h.type === 'implements_clause') impl.push(...heritageNames(h));
          }
        }
        sink.symbol({
          name,
          qname: q,
          sub: 'class',
          line: line(n),
          endLine: endLine(n),
          exported: ctx.exported,
          ...(ctx.cls ? { parent: ctx.cls } : {}),
          ...(ext.length ? { extends: ext } : {}),
          ...(impl.length ? { implements: impl } : {}),
        });
        const body = field(n, 'body');
        if (body) push(body, { cls: q, fn: q, inFn: false, exported: false });
        break;
      }
      case 'interface_declaration': {
        const name = text(field(n, 'name'));
        if (!name || ctx.inFn) break;
        const ext: string[] = [];
        for (const c of named(n)) if (c.type === 'extends_type_clause') ext.push(...heritageNames(c));
        sink.symbol({
          name,
          qname: qual(ctx.cls, name),
          sub: 'interface',
          line: line(n),
          endLine: endLine(n),
          exported: ctx.exported,
          ...(ext.length ? { extends: ext } : {}),
        });
        break;
      }
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const name = text(field(n, 'name'));
        if (!name || ctx.inFn) break;
        sink.symbol({
          name,
          qname: qual(ctx.cls, name),
          sub: n.type === 'enum_declaration' ? 'enum' : 'type',
          line: line(n),
          endLine: endLine(n),
          exported: ctx.exported,
        });
        break;
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        if (!name || ctx.inFn) {
          if (body) push(body, { ...ctx, inFn: true });
          break;
        }
        const q = qual(ctx.cls, name);
        sink.symbol({
          name,
          qname: q,
          sub: 'function',
          line: line(n),
          endLine: endLine(n),
          exported: ctx.exported,
        });
        if (body) push(body, { ...ctx, fn: q, inFn: true, exported: false });
        break;
      }
      case 'method_definition': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        if (!name || ctx.inFn || !ctx.cls) {
          if (body) push(body, { ...ctx, inFn: true });
          break;
        }
        if (name === 'constructor') {
          if (body) push(body, { ...ctx, inFn: true });
          break;
        }
        const q = qual(ctx.cls, name);
        sink.symbol({
          name,
          qname: q,
          sub: 'method',
          line: line(n),
          endLine: endLine(n),
          exported: false,
          parent: ctx.cls,
        });
        if (body) push(body, { cls: ctx.cls, fn: q, inFn: true, exported: false });
        break;
      }
      case 'public_field_definition':
      case 'field_definition': {
        const name = text(field(n, 'name'));
        const value = field(n, 'value');
        if (
          name &&
          value &&
          !ctx.inFn &&
          ctx.cls &&
          /^(arrow_function|function_expression|function)$/.test(value.type)
        ) {
          const q = qual(ctx.cls, name);
          sink.symbol({
            name,
            qname: q,
            sub: 'method',
            line: line(n),
            endLine: endLine(n),
            exported: false,
            parent: ctx.cls,
          });
          const body = field(value, 'body');
          if (body) push(body, { cls: ctx.cls, fn: q, inFn: true, exported: false });
        } else if (value) push(value, ctx);
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of named(n)) {
          if (d.type !== 'variable_declarator') continue;
          const nameNode = field(d, 'name');
          const value = field(d, 'value');
          const name = nameNode?.type === 'identifier' ? nameNode.text : '';
          if (
            name &&
            value &&
            !ctx.inFn &&
            /^(arrow_function|function_expression|function)$/.test(value.type)
          ) {
            sink.symbol({
              name,
              qname: qual(ctx.cls, name),
              sub: 'function',
              line: line(d),
              endLine: endLine(d),
              exported: ctx.exported,
            });
            const body = field(value, 'body');
            if (body) push(body, { ...ctx, fn: qual(ctx.cls, name), inFn: true, exported: false });
          } else if (value) push(value, { ...ctx, exported: false });
        }
        break;
      }
      case 'call_expression': {
        const fn = field(n, 'function');
        const args = field(n, 'arguments');
        if (fn?.type === 'identifier' && fn.text === 'require' && args) {
          const first = args.namedChildren[0];
          if (first && (first.type === 'string' || first.type === 'template_string')) {
            sink.imp({ spec: stringValue(first), names: [{ name: '*', alias: '' }], line: line(n) });
            break;
          }
        }
        if (fn) {
          if (fn.type === 'identifier')
            sink.call({ callee: fn.text, ...(ctx.fn ? { from: ctx.fn } : {}), line: line(n) });
          else if (fn.type === 'member_expression') {
            const prop = text(field(fn, 'property'));
            const obj = field(fn, 'object');
            const recv = obj && (obj.type === 'identifier' || obj.type === 'this') ? obj.text : undefined;
            if (prop)
              sink.call({
                callee: prop,
                ...(recv ? { recv } : {}),
                ...(ctx.fn ? { from: ctx.fn } : {}),
                line: line(n),
              });
          }
        }
        pushChildren(n, { ...ctx, exported: false });
        break;
      }
      case 'new_expression': {
        const c = field(n, 'constructor');
        if (c) {
          const callee =
            c.type === 'member_expression'
              ? text(field(c, 'property'))
              : c.type === 'identifier'
                ? c.text
                : '';
          if (callee) sink.call({ callee, isNew: true, ...(ctx.fn ? { from: ctx.fn } : {}), line: line(n) });
        }
        pushChildren(n, { ...ctx, exported: false });
        break;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        const nm = text(field(n, 'name'));
        if (/^[A-Z]/.test(nm))
          sink.call({
            callee: lastSegment(nm),
            isNew: true,
            ...(ctx.fn ? { from: ctx.fn } : {}),
            line: line(n),
          });
        pushChildren(n, ctx);
        break;
      }
      case 'arrow_function':
      case 'function_expression':
      case 'function': {
        const body = field(n, 'body');
        if (body) push(body, { ...ctx, inFn: true, exported: false });
        break;
      }
      default:
        pushChildren(n, ctx.exported && n.type !== 'program' ? { ...ctx, exported: false } : ctx);
    }
  }
}

// -------------------------------------------------------------------------------------------------------- Python

function pyVisit(root: TsNode, sink: Sink): void {
  const stack: Frame[] = [{ node: root, ctx: { inFn: false, exported: false } }];
  const push = (n: TsNode, ctx: Ctx) => stack.push({ node: n, ctx });
  const pushChildren = (n: TsNode, ctx: Ctx) => {
    const kids = named(n);
    for (let i = kids.length - 1; i >= 0; i--) push(kids[i] as TsNode, ctx);
  };
  while (stack.length) {
    const { node: n, ctx } = stack.pop() as Frame;
    switch (n.type) {
      case 'import_statement': {
        for (const c of named(n)) {
          if (c.type === 'dotted_name') {
            const spec = c.text;
            sink.imp({ spec, names: [{ name: '*', alias: spec.split('.')[0] ?? spec }], line: line(n) });
          } else if (c.type === 'aliased_import') {
            const spec = text(field(c, 'name'));
            const alias = text(field(c, 'alias'));
            sink.imp({
              spec,
              names: [{ name: '*', alias: alias || (spec.split('.')[0] ?? spec) }],
              line: line(n),
            });
          }
        }
        break;
      }
      case 'import_from_statement': {
        const mod = field(n, 'module_name');
        let spec = '';
        let dots = 0;
        if (mod?.type === 'relative_import') {
          for (const c of named(mod)) {
            if (c.type === 'import_prefix') dots = c.text.length;
            else if (c.type === 'dotted_name') spec = c.text;
          }
        } else spec = text(mod);
        const names: ImportFact['names'] = [];
        for (const c of named(n)) {
          if (mod && c.id === mod.id) continue;
          if (c.type === 'dotted_name') names.push({ name: c.text });
          else if (c.type === 'aliased_import')
            names.push({ name: text(field(c, 'name')), alias: text(field(c, 'alias')) });
          else if (c.type === 'wildcard_import') names.push({ name: '*' });
        }
        sink.imp({ spec, names, line: line(n), ...(dots ? { dots } : {}) });
        break;
      }
      case 'decorated_definition': {
        const def = field(n, 'definition');
        if (def) push(def, ctx);
        break;
      }
      case 'class_definition': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        if (!name || ctx.inFn) {
          if (body) push(body, { ...ctx, inFn: true });
          break;
        }
        const q = qual(ctx.cls, name);
        const ext: string[] = [];
        const sup = field(n, 'superclasses');
        if (sup)
          for (const c of named(sup)) {
            if (c.type === 'identifier') ext.push(c.text);
            else if (c.type === 'attribute') ext.push(text(field(c, 'attribute')));
          }
        sink.symbol({
          name,
          qname: q,
          sub: 'class',
          line: line(n),
          endLine: endLine(n),
          exported: !name.startsWith('_'),
          ...(ctx.cls ? { parent: ctx.cls } : {}),
          ...(ext.length ? { extends: ext.filter(Boolean) } : {}),
        });
        if (body) push(body, { cls: q, fn: q, inFn: false, exported: false });
        break;
      }
      case 'function_definition': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        if (!name || ctx.inFn) {
          if (body) push(body, { ...ctx, inFn: true });
          break;
        }
        const q = qual(ctx.cls, name);
        sink.symbol({
          name,
          qname: q,
          sub: ctx.cls ? 'method' : 'function',
          line: line(n),
          endLine: endLine(n),
          exported: !name.startsWith('_'),
          ...(ctx.cls ? { parent: ctx.cls } : {}),
        });
        if (body) push(body, { ...ctx, fn: q, inFn: true, exported: false });
        break;
      }
      case 'call': {
        const fn = field(n, 'function');
        if (fn?.type === 'identifier')
          sink.call({
            callee: fn.text,
            ...(/^[A-Z]/.test(fn.text) ? { isNew: true } : {}),
            ...(ctx.fn ? { from: ctx.fn } : {}),
            line: line(n),
          });
        else if (fn?.type === 'attribute') {
          const obj = field(fn, 'object');
          const callee = text(field(fn, 'attribute'));
          const recv = obj?.type === 'identifier' ? obj.text : undefined;
          if (callee)
            sink.call({
              callee,
              ...(recv ? { recv } : {}),
              ...(ctx.fn ? { from: ctx.fn } : {}),
              line: line(n),
            });
        }
        pushChildren(n, ctx);
        break;
      }
      default:
        pushChildren(n, ctx);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------- Go

const goExported = (name: string) => /^[A-Z]/.test(name);

function goVisit(root: TsNode, sink: Sink): void {
  const stack: Frame[] = [{ node: root, ctx: { inFn: false, exported: false } }];
  const push = (n: TsNode, ctx: Ctx) => stack.push({ node: n, ctx });
  const pushChildren = (n: TsNode, ctx: Ctx) => {
    const kids = named(n);
    for (let i = kids.length - 1; i >= 0; i--) push(kids[i] as TsNode, ctx);
  };
  while (stack.length) {
    const { node: n, ctx } = stack.pop() as Frame;
    switch (n.type) {
      case 'package_clause':
        sink.namespaces.add(text(n.namedChildren[0]));
        break;
      case 'import_spec': {
        const path =
          n.descendantsOfType('interpreted_string_literal_content')[0]?.text ?? stringValue(field(n, 'path'));
        const alias = text(field(n, 'name'));
        if (path)
          sink.imp({
            spec: path,
            names: [
              {
                name: '*',
                alias: alias && alias !== '_' && alias !== '.' ? alias : (path.split('/').pop() ?? path),
              },
            ],
            line: line(n),
          });
        break;
      }
      case 'type_spec':
      case 'type_alias': {
        const name = text(field(n, 'name'));
        if (!name) break;
        const t = field(n, 'type');
        const sub: SymbolSub =
          t?.type === 'struct_type' ? 'struct' : t?.type === 'interface_type' ? 'interface' : 'type';
        sink.symbol({
          name,
          qname: name,
          sub,
          line: line(n),
          endLine: endLine(n),
          exported: goExported(name),
        });
        break;
      }
      case 'function_declaration': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        if (!name) break;
        sink.symbol({
          name,
          qname: name,
          sub: 'function',
          line: line(n),
          endLine: endLine(n),
          exported: goExported(name),
        });
        if (body) push(body, { fn: name, inFn: true, exported: false });
        break;
      }
      case 'method_declaration': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        const recvList = field(n, 'receiver');
        const recvType = recvList?.descendantsOfType('type_identifier')[0]?.text ?? '';
        if (!name) break;
        const q = recvType ? `${recvType}.${name}` : name;
        sink.symbol({
          name,
          qname: q,
          sub: recvType ? 'method' : 'function',
          line: line(n),
          endLine: endLine(n),
          exported: goExported(name),
          ...(recvType ? { parent: recvType } : {}),
        });
        if (body) push(body, { ...(recvType ? { cls: recvType } : {}), fn: q, inFn: true, exported: false });
        break;
      }
      case 'call_expression': {
        const fn = field(n, 'function');
        if (fn?.type === 'identifier')
          sink.call({ callee: fn.text, ...(ctx.fn ? { from: ctx.fn } : {}), line: line(n) });
        else if (fn?.type === 'selector_expression') {
          const operand = field(fn, 'operand');
          const callee = text(field(fn, 'field'));
          const recv = operand?.type === 'identifier' ? operand.text : undefined;
          if (callee)
            sink.call({
              callee,
              ...(recv ? { recv } : {}),
              ...(ctx.fn ? { from: ctx.fn } : {}),
              line: line(n),
            });
        }
        pushChildren(n, ctx);
        break;
      }
      case 'composite_literal': {
        const t = field(n, 'type');
        if (t?.type === 'type_identifier')
          sink.call({ callee: t.text, isNew: true, ...(ctx.fn ? { from: ctx.fn } : {}), line: line(n) });
        pushChildren(n, ctx);
        break;
      }
      default:
        pushChildren(n, ctx);
    }
  }
}

// ----------------------------------------------------------------------------------------------------------- C#

const csTypeName = (n: TsNode | null): string => {
  if (!n) return '';
  if (n.type === 'identifier') return n.text;
  if (n.type === 'generic_name') return text(n.namedChildren[0]);
  if (n.type === 'qualified_name')
    return csTypeName(field(n, 'name') ?? n.namedChildren[n.namedChildren.length - 1] ?? null);
  return lastSegment(n.text);
};

function csVisit(root: TsNode, sink: Sink): void {
  const stack: Frame[] = [{ node: root, ctx: { inFn: false, exported: false } }];
  const push = (n: TsNode, ctx: Ctx) => stack.push({ node: n, ctx });
  const pushChildren = (n: TsNode, ctx: Ctx) => {
    const kids = named(n);
    for (let i = kids.length - 1; i >= 0; i--) push(kids[i] as TsNode, ctx);
  };
  const TYPES: Record<string, SymbolSub> = {
    class_declaration: 'class',
    struct_declaration: 'struct',
    interface_declaration: 'interface',
    record_declaration: 'class',
    record_struct_declaration: 'struct',
    enum_declaration: 'enum',
  };
  while (stack.length) {
    const { node: n, ctx } = stack.pop() as Frame;
    switch (n.type) {
      case 'using_directive': {
        const kids = named(n);
        const target = kids[kids.length - 1];
        if (!target) break;
        const spec = target.text;
        const alias = kids.length > 1 ? text(kids[0]) : '';
        sink.imp({ spec, names: [{ name: '*', ...(alias ? { alias } : {}) }], line: line(n) });
        break;
      }
      case 'namespace_declaration':
      case 'file_scoped_namespace_declaration': {
        const name = text(field(n, 'name'));
        if (name) sink.namespaces.add(name);
        if (n.type === 'file_scoped_namespace_declaration') {
          // applies to the declarations that follow it, whether they are its children or its siblings
          ctx.ns = name;
          pushChildren(n, ctx);
        } else {
          const body = field(n, 'body');
          if (body) push(body, { ...ctx, ns: name });
          else pushChildren(n, { ...ctx, ns: name });
        }
        break;
      }
      case 'class_declaration':
      case 'struct_declaration':
      case 'interface_declaration':
      case 'record_declaration':
      case 'record_struct_declaration':
      case 'enum_declaration': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        if (!name || ctx.inFn) {
          if (body) push(body, ctx);
          break;
        }
        const q = qual(ctx.cls, name);
        const bases: string[] = [];
        for (const c of named(n))
          if (c.type === 'base_list') for (const b of named(c)) bases.push(csTypeName(b));
        const mods = named(n)
          .filter((c) => c.type === 'modifier')
          .map((c) => c.text);
        sink.symbol({
          name,
          qname: q,
          sub: TYPES[n.type] as SymbolSub,
          line: line(n),
          endLine: endLine(n),
          exported: mods.includes('public') || mods.includes('internal') || mods.length === 0,
          ...(ctx.cls ? { parent: ctx.cls } : {}),
          ...(bases.filter(Boolean).length ? { extends: bases.filter(Boolean) } : {}),
        });
        if (body)
          push(body, { cls: q, fn: q, inFn: false, exported: false, ...(ctx.ns ? { ns: ctx.ns } : {}) });
        else pushChildren(n, { cls: q, fn: q, inFn: false, exported: false });
        break;
      }
      case 'method_declaration': {
        const name = text(field(n, 'name'));
        const body = field(n, 'body');
        const mods = named(n)
          .filter((c) => c.type === 'modifier')
          .map((c) => c.text);
        if (name && ctx.cls && !ctx.inFn) {
          const q = `${ctx.cls}.${name}`;
          sink.symbol({
            name,
            qname: q,
            sub: 'method',
            line: line(n),
            endLine: endLine(n),
            exported: mods.includes('public') || mods.includes('internal') || mods.includes('protected'),
            parent: ctx.cls,
          });
          pushChildren(n, { cls: ctx.cls, fn: q, inFn: true, exported: false });
        } else if (body) push(body, { ...ctx, inFn: true });
        break;
      }
      case 'invocation_expression': {
        const fn = field(n, 'function');
        if (fn?.type === 'identifier' || fn?.type === 'generic_name')
          sink.call({ callee: csTypeName(fn), ...(ctx.fn ? { from: ctx.fn } : {}), line: line(n) });
        else if (fn?.type === 'member_access_expression') {
          const callee = csTypeName(field(fn, 'name'));
          const expr = field(fn, 'expression');
          const recv =
            expr &&
            (expr.type === 'identifier' || expr.type === 'this_expression' || expr.type === 'base_expression')
              ? expr.type === 'identifier'
                ? expr.text
                : 'this'
              : undefined;
          if (callee)
            sink.call({
              callee,
              ...(recv ? { recv } : {}),
              ...(ctx.fn ? { from: ctx.fn } : {}),
              line: line(n),
            });
        }
        pushChildren(n, ctx);
        break;
      }
      case 'object_creation_expression': {
        const t = csTypeName(field(n, 'type'));
        if (t) sink.call({ callee: t, isNew: true, ...(ctx.fn ? { from: ctx.fn } : {}), line: line(n) });
        pushChildren(n, ctx);
        break;
      }
      default:
        pushChildren(n, ctx);
    }
  }
}

// ------------------------------------------------------------------------------------------------------- entry

const VISITORS: Record<Exclude<Lang, 'markdown'>, (root: TsNode, sink: Sink) => void> = {
  typescript: tsVisit,
  tsx: tsVisit,
  javascript: tsVisit,
  python: pyVisit,
  go: goVisit,
  csharp: csVisit,
};

/** Facts of one source file. `content` is the file's text; a parse error drops nothing it could still read. */
export async function parseFile(lang: Lang, content: string): Promise<FileFacts> {
  if (lang === 'markdown') {
    const md = scanMarkdown(content);
    return { lang, symbols: [], imports: [], calls: [], headings: md.headings, links: md.links };
  }
  runtime ??= load();
  const rt = await runtime;
  rt.parser.setLanguage(await language(rt, lang));
  const tree = rt.parser.parse(content);
  if (!tree) return { lang, symbols: [], imports: [], calls: [], parseErrors: true };
  try {
    const sink = new Sink();
    VISITORS[lang](tree.rootNode, sink);
    const facts: FileFacts = { lang, symbols: sink.symbols, imports: sink.imports, calls: sink.calls };
    if (sink.namespaces.size) facts.namespaces = [...sink.namespaces].sort();
    if (tree.rootNode.hasError) facts.parseErrors = true;
    return facts;
  } finally {
    tree.delete();
  }
}

/** The grammar files the indexer loads (the build copies exactly these into `dist/grammars`). */
export const GRAMMAR_FILES: string[] = [...new Set(Object.values(GRAMMAR_FILES_BY_LANG))].sort();
