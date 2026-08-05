# @revisium/revo-run

Durable run orchestration for Revo.

The package is being rebuilt for the `0.2.x` alpha line. The previous `0.1.x` runtime has been
removed; no runtime API is currently available from `master`.

Target responsibilities:

- translate pipeline decisions into durable workflow operations;
- represent runs, node executions, and attempts through the workflow engine;
- expose run summaries and detailed execution state;
- provide durable run updates and terminal waiting.
