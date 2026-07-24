# Review Contract

Findings cite a file and line, name the violated contract, explain the risk, and
propose the smallest correction.

Block a change when it:

- presents a design-only specification as shipped behavior;
- imports or depends on `@revisium/revo-pipeline` or
  `@revisium/revo-agent-runtime`;
- lets a provider, Pipeline adapter, or caller persist or transition an attempt;
- bypasses the one JCS canonicalizer, accepts unsupported durable values, or
  computes a digest over anything other than canonical UTF-8 bytes;
- makes durable envelope fields open, weakens versioning/nullability rules, or
  changes state vocabulary without a new version;
- permits non-atomic evidence/record transition semantics in a future store;
- expands this PR into a controller, store implementation, provider, or
  Pipeline-adapter implementation;
- leaves exports, declarations, tests, package tarball proof, and README out of
  agreement; or
- suppresses format, type, lint, test, coverage, architecture, package, CI, or
  review findings.

Required local evidence is `pnpm verify`; remote CI, Sonar, and review threads
are checked after an approved push.
