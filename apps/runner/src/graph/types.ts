/**
 * Project graph types (docs/design/project-graphs.md sections 4 and 5). Everything in here is derived from the customer's
 * code and stays on the workstation (in the project vault): none of it is ever sent to the server.
 */

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
export type EdgeSource = 'ast' | 'regex' | 'doc' | 'llm' | 'git' | 'work' | 'owner';

export type NodeKind =
  | 'repo'
  | 'module'
  | 'file'
  | 'symbol'
  | 'doc'
  | 'test'
  | 'package'
  | 'project'
  | 'card'
  | 'decision'
  | 'order'
  | 'merge';

export type SymbolSub = 'class' | 'interface' | 'function' | 'method' | 'type' | 'enum' | 'struct' | 'route' | 'config';

export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'references'
  | 'documents'
  | 'tests'
  | 'depends_on'
  | 'touches'
  | 'decided'
  | 'links';

export interface GNode {
  id: string;
  kind: NodeKind;
  /** For `symbol`: its sub kind (class, function, ...); for `doc`: the heading level as `h1`..`h6`. */
  sub?: string;
  name: string;
  /** Repo-relative path with forward slashes (never absolute). */
  path?: string;
  line?: number;
  endLine?: number;
  /** The module id the node belongs to. */
  module?: string;
  exported?: boolean;
  lang?: string;
}

export interface GEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  conf: Confidence;
  src: EdgeSource;
  /** AMBIGUOUS: every candidate (the first one is also `to`). */
  targets?: string[];
}

// ------------------------------------------------------------------------------ per-file facts (cached)

export interface SymbolFact {
  name: string;
  /** Qualified within the file: `Class.method`, or `Ns.Class.method` for C#. */
  qname: string;
  sub: SymbolSub;
  line: number;
  endLine: number;
  exported: boolean;
  /** The qname of the containing class or type, when there is one. */
  parent?: string;
  /** Written names of the base class and the implemented interfaces (resolved later). */
  extends?: string[];
  implements?: string[];
}

export interface ImportFact {
  /** The module as written: `./x.js`, `@aom/shared`, `a.b.c`, `Acme.Shop.Util`, `example.com/x/y`. */
  spec: string;
  /** What is bound locally: `{name, alias?}`; `*` for a namespace import (alias is its local name). */
  names: Array<{ name: string; alias?: string }>;
  line: number;
  /** A relative Python import: the number of leading dots. */
  dots?: number;
}

export interface CallFact {
  /** The callee's written name (`foo`, `thing` for `ns.thing()`). */
  callee: string;
  /** The receiver, when it is a plain identifier or `this`/`self`. */
  recv?: string;
  /** The qname of the enclosing symbol; absent: top level of the file. */
  from?: string;
  line: number;
  /** `new X()` / `X()` that may construct. */
  isNew?: boolean;
}

export interface FileFacts {
  lang: string;
  symbols: SymbolFact[];
  imports: ImportFact[];
  calls: CallFact[];
  /** C# namespaces, Go package name (as `package`), Python none. */
  namespaces?: string[];
  /** Markdown headings. */
  headings?: Array<{ level: number; text: string; line: number }>;
  /** Markdown links to relative targets. */
  links?: Array<{ target: string; line: number }>;
  /** The parse tree had errors (still used: tree-sitter recovers). */
  parseErrors?: boolean;
  /** The file was read and left out (a generated marker, binary content): remembered so it is not read again. */
  skip?: 'generated' | 'binary';
}

export interface TreeEntry {
  path: string;
  blob: string;
  size: number;
}
