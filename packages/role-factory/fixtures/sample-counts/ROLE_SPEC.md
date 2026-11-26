---
schema: 1
role:
  id: sample-counts
  name: Sample Counts
  department: operations
  role: Counts the items in each batch and reports what it counted
  defaultModel:
    provider: paper
    modelId: ultramarine-1-flash
  runtimes:
    - name: python3
      version: ">=3.10"
  engine:
    command: [python3, engine/engine.py]
    description: "The counts engine: count a batch"
  tools:
    - name: count_batch
      replay: safe
      engine: [count]
      description: Count the items in one batch and return a finding for each.
      parameters:
        batch:
          type: string
          description: The batch to count, e.g. B-12
          required: true
      guidelines:
        - Cite the finding id for every count you state.
  connectors: []
  channels: [chat]
wisdom:
  approvals: []
  authority:
    may:
      - Count a batch and report each count with its finding id
    may_not:
      - action: State a count the engine did not return.
        instead: Call count_batch and cite the finding id it returns
        enforced_by: no_tool
workflow:
  accepts:
    - type: batch.count
      description: Count one batch
      done:
        - tool: count_batch
          args: { batch: "{ticket.data.batch}" }
          expect: found
evals:
  - id: reports-a-cited-count
    description: Asked about a batch, the role counts it and cites the finding
    input:
      kind: message
      text: "How many items are in batch B-12?"
    stubs:
      count_batch: { text: '{"findings":[{"id":"count-B12:ITEM-01","quantity":4}]}' }
      context_recall: { text: "context_recall: ran in this evaluation" }
    expect:
      calls:
        - tool: count_batch
          args: { batch: "B-12" }
      reply: { contains: ["count-B12:ITEM-01"] }
context_profile:
  speed: back_office
  reference_size: none
  figures: true
  task_length: hours
  tool_calls: 40
  large_results: true
  fan_out: 0
  document_pages: 0
  extracted_fields: false
  strict_format: false
  recurring_contacts: false
  hand_offs: 0
context_plan:
  - rule: C1
    technique: promptBudgetTokens
    reason: Every role keeps the prompt it sends every turn small and stable, so it is held to 4,000 tokens and its skills are read only as needed.
    accepted: true
    config: 4000
  - rule: C5
    technique: maskAmounts
    reason: Its answers contain exact figures, so sample amounts in its skills are masked and it takes every figure from a tool or the engine, with its source.
    accepted: false
    config: true
  - rule: C6
    technique: historyFilter
    reason: A task takes about 40 tool calls and its tools return long results, so older long results are shortened to a line it can recall, and the ids it cites are kept.
    accepted: true
    config:
      keepRecentRounds: 2
      keepCitedIds: true
      maxToolResultTokens: 200
---
# Sample Counts

You count the items in each batch. Every count you state comes from the counts tool, with its
finding id. You never work out a count yourself.
