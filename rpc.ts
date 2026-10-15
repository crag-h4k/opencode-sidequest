// rpc.ts
import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

export const NodeState = Schema.Literals(["pending", "running", "completed", "failed", "skipped", "cancelled"])

export const Node = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  state: NodeState,
  attempt: Schema.Number,
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  timeout: Schema.optionalKey(Schema.Number),
  maxCost: Schema.optionalKey(Schema.Number),
  maxTokens: Schema.optionalKey(Schema.Number),
  retries: Schema.optionalKey(Schema.Number),
  sessionID: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.Number),
  finishedAt: Schema.optionalKey(Schema.Number),
  activity: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.String),
})

export const Run = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  sessionID: Schema.String,
  status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  revision: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  maxParallel: Schema.Number,
  nodes: Schema.Array(Node),
  finishedAt: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
})

export const AgentDag = Rpc.define({
  id: "questline.dag",
  methods: {
    snapshot: {
      input: Schema.Struct({ sessionID: Schema.String }),
      output: Schema.Struct({ runs: Schema.Array(Run) }),
    },
    cancel: {
      input: Schema.Struct({ runId: Schema.String }),
      output: Schema.Struct({ run: Schema.optionalKey(Run) }),
    },
    retry: {
      input: Schema.Struct({ runId: Schema.String }),
      output: Schema.Struct({ run: Schema.optionalKey(Run) }),
      errors: {
        not_finished: Schema.Struct({ runId: Schema.String }),
      },
    },
  },
  events: {
    updated: {
      schema: Schema.Struct({ sessionID: Schema.String, run: Run }),
    },
  },
})
