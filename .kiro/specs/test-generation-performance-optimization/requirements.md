# Requirements Document

## Introduction

This feature optimizes the existing test generation pipeline to reduce end-to-end generation time by 40–60% while preserving question quality. The current pipeline runs synchronously inside a single HTTP request (`POST /upload`) and executes LLM batches sequentially, with grounding validation, semantic deduplication, and up to three backfill rounds adding substantial overhead. The frontend polls `/api/jobs/:id` every 1.8 seconds, which delays progress feedback and increases server load.

The optimization introduces a background job queue (BullMQ + Redis) so the upload endpoint returns a `jobId` immediately, parallelizes LLM batch generation under RPM control, replaces polling with Server-Sent Events (SSE) for real-time progress, makes grounding conditional based on routing mode, caches blueprints by document hash, batches database inserts, and caches embeddings to avoid redundant API calls. Quality-sensitive routing modes (e.g., `max_quality`) retain full grounding and backfill behavior; throughput-sensitive modes (`economy`, `balanced`) trade some grounding rigor for speed.

## Glossary

- **Test_Generation_Pipeline**: The orchestrator (`backend/services/pipeline/testGeneratorFlow.js`) that executes the multi-stage flow producing a finished test from an uploaded document.
- **Upload_Endpoint**: The HTTP handler `POST /upload` that accepts a document and initiates test generation.
- **Job_Queue**: The BullMQ-backed queue holding generation jobs to be processed by background workers, backed by Redis.
- **Job_Worker**: A Node.js process consuming jobs from the Job_Queue and executing the Test_Generation_Pipeline.
- **Job_Status_Endpoint**: The HTTP endpoint `GET /api/jobs/:id` returning the current status snapshot of a generation job.
- **Job_Stream_Endpoint**: The Server-Sent Events endpoint streaming real-time progress updates for a given `jobId`.
- **Routing_Mode**: A configured pipeline profile (`economy`, `balanced`, `quality`, `max_quality`, or a custom profile) that controls model selection and quality-versus-speed trade-offs.
- **Blueprint_Stage**: The pipeline stage that produces themes and intents from indexed chunks via an LLM call.
- **Main_Batch_Loop**: The pipeline stage `runMainBatchLoop` that generates questions in batches from the blueprint intents.
- **Grounding_Validator**: The component that issues an additional LLM call per batch to verify each question is grounded in source chunks.
- **Backfill_Loop**: The stage that issues additional LLM batches (up to three rounds) when the Main_Batch_Loop produces fewer questions than the budget.
- **Semantic_Deduper**: The component that removes near-duplicate questions using embedding similarity.
- **Embedding_Cache**: A keyed cache of `(text_hash, model) → embedding_vector` used to skip repeated embedding API calls.
- **Blueprint_Cache**: A keyed cache of `(document_hash, routing_mode, question_count) → blueprint` used to skip repeated Blueprint_Stage execution for identical inputs.
- **Quota_Guard**: The existing `quotaGuard` service that enforces per-model RPM (requests per minute) limits.
- **RPM**: Requests per minute, the rate limit unit used by Quota_Guard.
- **Job_Progress_Repo**: The repository (`jobProgressRepo`) that persists the current pipeline phase, percentage, and metadata for each job.
- **Document_Hash**: A SHA-256 hex digest of the parsed document text, used as the Blueprint_Cache key component.
- **SSE**: Server-Sent Events, a one-way HTTP streaming protocol delivered with `Content-Type: text/event-stream`.

## Requirements

### Requirement 1: Asynchronous Job Submission

**User Story:** As a user uploading a document, I want the upload request to return immediately with a job identifier, so that I can track progress without waiting for an HTTP response that may time out on long generations.

#### Acceptance Criteria

1. WHEN a client submits a document to the Upload_Endpoint, THE Upload_Endpoint SHALL enqueue a generation job in the Job_Queue and return HTTP 202 with a JSON body containing the `jobId` within 2 seconds of receiving the request.
2. WHEN a generation job is enqueued, THE Job_Queue SHALL persist the job payload in Redis so that the job survives a restart of the API process before a Job_Worker picks it up.
3. THE Upload_Endpoint SHALL NOT block on any pipeline stage beyond document upload, parsing, and persistence of document metadata.
4. IF the Job_Queue is unavailable when an upload is received, THEN THE Upload_Endpoint SHALL return HTTP 503 with an error code `queue_unavailable` and SHALL NOT consume any LLM quota.
5. WHEN a Job_Worker starts processing a job, THE Job_Worker SHALL execute the full Test_Generation_Pipeline and SHALL produce a result equivalent to the current synchronous pipeline output for the same inputs and Routing_Mode.

### Requirement 2: Background Worker Execution

**User Story:** As an operator, I want generation work to run in dedicated worker processes, so that long-running jobs do not block the API and so that I can scale horizontally by adding workers.

#### Acceptance Criteria

1. THE Job_Worker SHALL be deployable as a separate Node.js process that consumes jobs from the Job_Queue.
2. WHERE multiple Job_Worker instances are running, THE Job_Queue SHALL deliver each job to exactly one Job_Worker.
3. IF a Job_Worker crashes mid-execution, THEN THE Job_Queue SHALL re-deliver the job to another available Job_Worker up to a configurable maximum of `JOB_MAX_ATTEMPTS` retries (default 2).
4. WHEN a Job_Worker exceeds the configured `JOB_TIMEOUT_MS` (default 600000) for a single job, THE Job_Queue SHALL mark the job as failed with reason `timeout` and SHALL release worker resources.
5. THE Job_Worker SHALL report per-stage progress to the Job_Progress_Repo at the start and end of each pipeline stage.

### Requirement 3: Real-Time Progress via Server-Sent Events

**User Story:** As a user watching a generation in progress, I want progress updates to appear immediately, so that the UI feels responsive without polling delays.

#### Acceptance Criteria

1. THE Job_Stream_Endpoint SHALL accept GET requests at `/api/jobs/:id/stream` and SHALL respond with `Content-Type: text/event-stream`.
2. WHEN a Job_Worker writes a progress update to the Job_Progress_Repo, THE Job_Stream_Endpoint SHALL emit an SSE event named `progress` with a JSON payload containing `jobId`, `phase`, `percent`, and `message` to all connected clients for that `jobId` within 500 ms of the database write.
3. WHEN a generation job reaches a terminal state (`completed`, `failed`, `cancelled`), THE Job_Stream_Endpoint SHALL emit a final SSE event named `terminal` with the terminal state and SHALL close the connection.
4. WHILE a client is connected to the Job_Stream_Endpoint, THE Job_Stream_Endpoint SHALL emit a `keepalive` comment line at least every 30 seconds to prevent intermediary timeouts.
5. WHERE the client disconnects before a terminal event, THE Job_Stream_Endpoint SHALL release any subscription resources within 5 seconds of disconnection.
6. THE Job_Status_Endpoint SHALL remain available as a fallback returning the latest snapshot for clients that do not support SSE.

### Requirement 4: Parallel LLM Batch Generation

**User Story:** As a user generating a 30-question test, I want the question batches to run in parallel where the API allows, so that wall-clock generation time is reduced.

#### Acceptance Criteria

1. WHEN the Main_Batch_Loop has more than one batch to execute, THE Main_Batch_Loop SHALL dispatch up to `LLM_BATCH_PARALLELISM` (default 4) batches concurrently using `Promise.all` semantics.
2. THE Main_Batch_Loop SHALL submit each concurrent batch through Quota_Guard so that the configured per-model RPM limit is not exceeded.
3. IF Quota_Guard reports that an additional concurrent batch would exceed the RPM limit, THEN THE Main_Batch_Loop SHALL queue the batch and SHALL execute it as soon as quota becomes available.
4. WHEN any concurrent batch fails with a retryable error, THE Main_Batch_Loop SHALL retry that batch independently without aborting the other in-flight batches.
5. THE Main_Batch_Loop SHALL preserve the existing question ordering contract by tagging each generated question with its source intent and batch index so that downstream stages observe a deterministic order regardless of completion order.
6. WHERE `LLM_BATCH_PARALLELISM` is set to 1, THE Main_Batch_Loop SHALL behave identically to the current sequential implementation.

### Requirement 5: Conditional Grounding Validation

**User Story:** As a user choosing a routing mode, I want grounding validation to run only when quality demands it, so that economy and balanced modes are faster without sacrificing the rigor of quality-focused modes.

#### Acceptance Criteria

1. WHERE the active Routing_Mode is `quality` or `max_quality`, THE Grounding_Validator SHALL run for every generated batch.
2. WHERE the active Routing_Mode is `economy` or `balanced`, THE Grounding_Validator SHALL be skipped by default.
3. WHERE a custom profile in `customModeProfilesRepo` sets `grounding_enabled = true`, THE Grounding_Validator SHALL run regardless of the base Routing_Mode.
4. WHEN the Grounding_Validator is skipped, THE Test_Generation_Pipeline SHALL emit a structured log entry with reason code `grounding_skipped_by_mode` and SHALL include the active Routing_Mode in the log payload.
5. THE Test_Generation_Pipeline SHALL surface the grounding policy decision (`enabled` or `skipped`) in the job result metadata so that clients can display it.

### Requirement 6: Blueprint Cache by Document Hash

**User Story:** As a user re-running generation on the same document, I want the blueprint stage to be skipped on cache hits, so that repeated generations are faster and consume fewer LLM tokens.

#### Acceptance Criteria

1. WHEN the Blueprint_Stage is invoked, THE Test_Generation_Pipeline SHALL compute the Document_Hash and SHALL look up the Blueprint_Cache using the key `(document_hash, routing_mode, question_count, language)`.
2. WHERE a Blueprint_Cache entry exists for the lookup key and is not expired, THE Test_Generation_Pipeline SHALL reuse the cached blueprint and SHALL skip the Blueprint_Stage LLM call.
3. WHEN the Blueprint_Stage produces a new blueprint, THE Test_Generation_Pipeline SHALL store the blueprint in the Blueprint_Cache with a configurable `BLUEPRINT_CACHE_TTL_SECONDS` (default 86400).
4. IF the Blueprint_Cache backend is unavailable, THEN THE Test_Generation_Pipeline SHALL log a warning with reason code `blueprint_cache_unavailable` and SHALL execute the Blueprint_Stage normally.
5. WHEN a cache hit occurs, THE Test_Generation_Pipeline SHALL emit a structured log entry containing `cache_hit=true`, the Document_Hash, and the cache age in seconds.

### Requirement 7: Embedding Cache for Deduplication and Indexing

**User Story:** As a user, I want repeated text fragments to skip embedding API calls, so that indexing and deduplication phases are faster on documents with overlapping content.

#### Acceptance Criteria

1. WHEN the Test_Generation_Pipeline requests an embedding for a text fragment, THE Embedding_Cache SHALL be checked using the key `(sha256(text), embedding_model)`.
2. WHERE the Embedding_Cache contains a vector for the lookup key, THE Test_Generation_Pipeline SHALL use the cached vector and SHALL NOT call the embedding API.
3. WHEN the embedding API returns a new vector, THE Test_Generation_Pipeline SHALL store the vector in the Embedding_Cache with TTL `EMBEDDING_CACHE_TTL_SECONDS` (default 604800).
4. THE Embedding_Cache SHALL bound its memory usage by evicting entries using a least-recently-used policy when it exceeds `EMBEDDING_CACHE_MAX_ENTRIES` (default 50000).
5. IF the Embedding_Cache backend is unavailable, THEN THE Test_Generation_Pipeline SHALL log a warning with reason code `embedding_cache_unavailable` and SHALL fall through to the embedding API.

### Requirement 8: Bulk Database Inserts

**User Story:** As an operator, I want pipeline persistence stages to use bulk inserts, so that database round-trips do not dominate end-of-pipeline latency.

#### Acceptance Criteria

1. WHEN persisting intents at the end of the Blueprint_Stage, THE Test_Generation_Pipeline SHALL execute a single multi-row `INSERT` statement instead of one statement per intent.
2. WHEN persisting question source links at the end of generation, THE Test_Generation_Pipeline SHALL execute a single multi-row `INSERT` statement instead of one statement per source link.
3. WHEN persisting chunks at the end of indexing, THE Test_Generation_Pipeline SHALL execute a single multi-row `INSERT` statement instead of one statement per chunk.
4. WHERE the row count for any bulk insert exceeds `BULK_INSERT_MAX_ROWS` (default 1000), THE Test_Generation_Pipeline SHALL split the rows into chunks of at most `BULK_INSERT_MAX_ROWS` and SHALL execute one statement per chunk.
5. IF a bulk insert fails, THEN THE Test_Generation_Pipeline SHALL roll back the enclosing transaction and SHALL fail the job with reason code `db_bulk_insert_failed`.

### Requirement 9: Routing-Mode-Aware Backfill Policy

**User Story:** As a user choosing a routing mode, I want backfill rounds to run only when needed for quality, so that economy mode does not pay for additional rounds when initial generation already produces enough questions.

#### Acceptance Criteria

1. WHEN the Main_Batch_Loop produces at least the requested question count, THE Backfill_Loop SHALL be skipped.
2. WHERE the active Routing_Mode is `economy`, THE Backfill_Loop SHALL execute at most one additional round.
3. WHERE the active Routing_Mode is `balanced`, THE Backfill_Loop SHALL execute at most two additional rounds.
4. WHERE the active Routing_Mode is `quality` or `max_quality`, THE Backfill_Loop SHALL execute up to three additional rounds, preserving the current behavior.
5. WHEN the Backfill_Loop is skipped or capped by the Routing_Mode policy, THE Test_Generation_Pipeline SHALL emit a structured log entry with reason code `backfill_capped_by_mode` and SHALL include the active Routing_Mode and the cap value.

### Requirement 10: Quota Guard for Concurrent Calls

**User Story:** As an operator, I want parallel LLM calls to respect provider rate limits, so that the system does not trigger 429 errors or exhaust quota under load.

#### Acceptance Criteria

1. THE Quota_Guard SHALL track the number of in-flight requests per model in addition to the existing RPM tracking.
2. WHEN the Test_Generation_Pipeline issues a parallel LLM request, THE Quota_Guard SHALL acquire a slot before the request is dispatched and SHALL release the slot after the response is received or the request fails.
3. IF acquiring a slot would exceed the configured RPM limit for the target model, THEN THE Quota_Guard SHALL delay the request until a slot becomes available or until `QUOTA_WAIT_TIMEOUT_MS` (default 30000) elapses.
4. IF the wait timeout elapses, THEN THE Quota_Guard SHALL reject the request with reason code `quota_wait_timeout` and SHALL allow the caller to fall back to a different model.
5. THE Quota_Guard SHALL expose current in-flight and per-minute counts via a metrics endpoint for observability.

### Requirement 11: Generation Time Budget and Reporting

**User Story:** As a product owner, I want measurable evidence that the optimization meets the 40–60% reduction target, so that I can validate the change against the goal.

#### Acceptance Criteria

1. WHEN a generation job completes, THE Test_Generation_Pipeline SHALL persist a `total_duration_ms` and per-stage `duration_ms` in the run record.
2. THE Test_Generation_Pipeline SHALL emit a structured log entry on job completion containing `total_duration_ms`, `routing_mode`, `question_count`, `cache_hits`, `parallel_batches`, and `grounding_enabled`.
3. WHEN measured against the baseline (synchronous pipeline, sequential batches, grounding always on, polling UI) on a 30-question generation in `balanced` mode with cold caches, THE optimized Test_Generation_Pipeline SHALL achieve a `total_duration_ms` reduction of at least 40%.
4. WHEN measured against the baseline on a 30-question generation in `balanced` mode with warm Blueprint_Cache and Embedding_Cache, THE optimized Test_Generation_Pipeline SHALL achieve a `total_duration_ms` reduction of at least 60%.
5. THE Test_Generation_Pipeline SHALL expose a benchmark script that runs the baseline and optimized pipelines and SHALL produce a comparison report covering the scenarios in criteria 3 and 4.

### Requirement 12: Quality Preservation

**User Story:** As a user, I want the optimized pipeline to produce questions of the same quality as the current pipeline in quality-focused modes, so that performance gains do not regress correctness.

#### Acceptance Criteria

1. WHERE the active Routing_Mode is `quality` or `max_quality`, THE optimized Test_Generation_Pipeline SHALL produce the same set of questions as the current pipeline for the same inputs and seed, within a semantic similarity threshold of 0.95.
2. WHEN grounding is enabled, THE Grounding_Validator SHALL apply the same acceptance threshold as the current pipeline.
3. WHEN deduplication runs, THE Semantic_Deduper SHALL apply the same similarity threshold as the current pipeline.
4. THE Test_Generation_Pipeline SHALL retain the existing fallback strategy (`buildOfflineMcqFromChunks`) for cases where LLM generation fails entirely.
5. WHEN a regression test suite is run, THE optimized Test_Generation_Pipeline SHALL pass all existing pipeline regression tests without modification of expected outputs.

### Requirement 13: Backwards Compatibility and Feature Flags

**User Story:** As an operator, I want each optimization to be individually toggleable, so that I can roll out changes incrementally and roll back quickly if a regression is detected.

#### Acceptance Criteria

1. THE Test_Generation_Pipeline SHALL read the following feature flags from configuration: `JOB_QUEUE_ENABLED`, `LLM_BATCH_PARALLELISM`, `GROUNDING_POLICY`, `BLUEPRINT_CACHE_ENABLED`, `EMBEDDING_CACHE_ENABLED`, `BULK_INSERT_ENABLED`, `SSE_ENABLED`.
2. WHERE `JOB_QUEUE_ENABLED` is false, THE Upload_Endpoint SHALL execute the pipeline synchronously using the current behavior.
3. WHERE `SSE_ENABLED` is false, THE Job_Stream_Endpoint SHALL respond with HTTP 404 and clients SHALL fall back to polling the Job_Status_Endpoint.
4. WHERE `BLUEPRINT_CACHE_ENABLED` is false, THE Test_Generation_Pipeline SHALL skip Blueprint_Cache reads and writes and SHALL execute the Blueprint_Stage on every run.
5. WHEN any feature flag is changed, THE Test_Generation_Pipeline SHALL pick up the new value on the next job without requiring a process restart, except for `JOB_QUEUE_ENABLED` which MAY require a restart of the API and Job_Worker processes.

### Requirement 14: Error Handling for Distributed Execution

**User Story:** As an operator, I want clear error reporting when background jobs fail, so that I can diagnose issues without searching multiple logs.

#### Acceptance Criteria

1. WHEN a Job_Worker fails a job, THE Job_Worker SHALL persist the error class, error message, stage name, and trace identifier to the Job_Progress_Repo.
2. WHEN the Job_Stream_Endpoint detects that a job has failed, THE Job_Stream_Endpoint SHALL emit a `terminal` SSE event with the failure metadata and SHALL close the connection.
3. IF Redis becomes unavailable while jobs are in progress, THEN the Job_Worker SHALL continue executing the current job and SHALL retry persisting progress with exponential backoff up to `REDIS_RETRY_MAX_MS` (default 30000) before failing the job with reason code `redis_unavailable`.
4. WHEN a job is cancelled by the user, THE Job_Worker SHALL stop dispatching new LLM batches within 2 seconds and SHALL mark the job as `cancelled` once in-flight batches complete or are aborted.
5. THE Job_Status_Endpoint SHALL include the failure metadata in its JSON response when the job is in a failed state.

### Requirement 15: Streaming Blueprint Stage

**User Story:** As a user, I want the blueprint stage to stream partial themes as they are produced, so that downstream batch generation can start before the entire blueprint LLM response is complete.

#### Acceptance Criteria

1. WHERE the Gemini API supports streaming for the configured blueprint model, THE Blueprint_Stage SHALL consume the streaming response and SHALL emit themes incrementally as they are parsed.
2. WHEN the first complete theme is parsed from the streaming response, THE Main_Batch_Loop SHALL be allowed to start generating questions for that theme without waiting for the remainder of the blueprint.
3. IF streaming fails partway through, THEN THE Blueprint_Stage SHALL fall back to a non-streaming retry and SHALL log reason code `blueprint_stream_fallback`.
4. WHERE streaming is disabled by configuration flag `BLUEPRINT_STREAMING_ENABLED=false`, THE Blueprint_Stage SHALL behave identically to the current non-streaming implementation.
5. THE Blueprint_Stage SHALL guarantee that the final set of themes emitted via streaming equals the set that would be produced by the non-streaming implementation for the same inputs.
