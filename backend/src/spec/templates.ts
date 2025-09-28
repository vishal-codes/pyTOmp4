// A compact, model-facing spec of allowed scene types and their parameters.
// Keep this stable; bump "version" if you add/change scenes or fields.

export const TEMPLATE_SPEC = {
  version: "1.0.0",
  global_rules: [
    "Keep total scenes ≤ 150.",
    "Prefer arrays with ≤ 12 items for clarity.",
    "Indices must be integers ≥ 0.",
    "In ArrayTape frames, maintain 0 ≤ left ≤ mid ≤ right < array.length when those fields are present.",
    "Emit ComplexityCard exactly once near the end.",
    "ResultCard should be the last scene."
  ],
  scenes: {
    // Meta / framing
    TitleCard: {
      required: { text: "string[1..80]" },
      optional: {}
    },
    Callout: {
      required: { text: "string[1..160]" },
      optional: {}
    },
    ComplexityCard: {
      required: {},
      optional: {}
    },
    ResultCard: {
      required: { text: "string[1..140]" },
      optional: {}
    },

    // Code view (optional)
    CodePanel: {
      required: { code: "string" },
      optional: { highlight: "tuple[int startLine, int endLine]" }
    },

    // Arrays / pointers / windows
    ArrayTape: {
      required: {},
      optional: {
        array: "int[]   // may omit if unchanged from previous ArrayTape",
        left: "int",
        right: "int",
        mid: "int",
        window: "tuple[int start, int end] // inclusive indices for sliding window"
      }
    },
    MovePointer: {
      required: { which: "'left'|'right'", to: "int" },
      optional: {}
    },

    // Maps / sets
    HashMapPanel: {
      required: {
        ops:
          "[ {op:'insert', key:int, value:int} | {op:'check', key:int, found:boolean} ]+"
      },
      optional: {}
    },

    // Linked lists
    LLNodes: {
      required: { values: "int[]" },
      optional: { highlight: "int" }
    },
    RewireEdge: {
      required: { src: "int", dst: "int" },
      optional: {}
    },

    // Stacks / queues
    StackPanel: {
      required: { items: "(int|string)[]" },
      optional: { op: "'push'|'pop'", value: "int|string" }
    },
    QueuePanel: {
      required: { items: "(int|string)[]" },
      optional: { op: "'enqueue'|'dequeue'", value: "int|string" }
    }
  }
} as const;

export function specJSON() {
  return JSON.stringify(TEMPLATE_SPEC, null, 2);
}
